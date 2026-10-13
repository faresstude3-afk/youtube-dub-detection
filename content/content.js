/**
 * YouTube Arabic Dub Indicator - Content Script (v1.8.0 Hyper-Speed Turbo)
 * Extreme performance optimizations:
 * 1. Stream Early-Abort: Reads HTML via ReadableStream and aborts connection as soon as
 *    ytInitialPlayerResponse is found (~120KB instead of downloading full 1.5MB HTML).
 * 2. 0ms Synchronous Cache Hit: Already-checked videos get their badge in 0ms without async microtasks.
 * 3. Dual Priority Queue: Top-to-bottom reading order for visible videos (no reverse order lag).
 * 4. 6 Parallel Workers: Full HTTP/2 stream multiplexing with zero artificial sleep delays.
 * 5. 1000px Pre-Fetch Margin: Upcoming videos are resolved before the user scrolls to them.
 * 6. Strict Multi-Language Filter: Never badges native Arabic content or single-track videos.
 */

(function () {
  'use strict';

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  console.log('[YT-Arabic-Dub] ⚡ Hyper-Speed Turbo v1.8.0 Active');

  const SETTINGS = {
    isEnabled: true,
    badgePosition: 'right',
    badgeText: 'دبلجة عربية',
    badgeTheme: 'indigo'
  };

  // Performance Configuration
  const CACHE_KEY = 'yt_dub_cache_v5';
  const MAX_CACHE_SIZE = 400;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CONCURRENT_LIMIT = 6; // 6 parallel HTTP/2 streams for ultra-fast resolution

  const memoryCache = new Map();
  const pendingPromises = new Map();
  const highPriorityQueue = []; // Videos currently visible on screen (top-to-bottom order)
  const lowPriorityQueue = [];  // Off-screen prefetch zone (within 1000px)
  let activeWorkers = 0;

  // Modern Headset SVG Icon
  const HEADSET_SVG = `
    <svg viewBox="0 0 24 24">
      <path d="M12 3a9 9 0 0 0-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1a7 7 0 0 1 14 0v1h-4v8h4c1.1 0 2-.9 2-2v-7a9 9 0 0 0-9-9z"/>
    </svg>
  `;

  // ==========================================
  // 1. Auto-Cleaning Lightweight Cache (O(1) FIFO)
  // ==========================================

  function enforceCacheLimit() {
    while (memoryCache.size > MAX_CACHE_SIZE) {
      const oldestKey = memoryCache.keys().next().value;
      if (oldestKey === undefined) break;
      memoryCache.delete(oldestKey);
    }
  }

  function setCacheEntry(videoId, value) {
    if (memoryCache.has(videoId)) {
      memoryCache.delete(videoId);
    }
    memoryCache.set(videoId, value);
    enforceCacheLimit();
  }

  function loadCache() {
    try {
      localStorage.removeItem('yt_dub_cache_v4');
      localStorage.removeItem('yt_dub_cache_v3');
      localStorage.removeItem('yt_dub_cache_v2');

      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const now = Date.now();
        const entries = Object.entries(parsed);
        const startIdx = Math.max(0, entries.length - MAX_CACHE_SIZE);
        for (let i = startIdx; i < entries.length; i++) {
          const [id, val] = entries[i];
          if (val && (now - (val.timestamp || 0)) < CACHE_TTL_MS) {
            memoryCache.set(id, val);
          }
        }
      }
    } catch (e) {}
  }

  let saveTimer = null;
  function saveCache() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        enforceCacheLimit();
        const obj = {};
        for (const [k, v] of memoryCache.entries()) {
          obj[k] = v;
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
      } catch (e) {
        memoryCache.clear();
        try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
      }
    }, 2000);
  }

  // ==========================================
  // 2. Stream Early-Abort Parser & Dubbing Filter
  // ==========================================

  function findStartMarker(text) {
    const markers = [
      'ytInitialPlayerResponse = ',
      'var ytInitialPlayerResponse = ',
      'window["ytInitialPlayerResponse"] = ',
      "window['ytInitialPlayerResponse'] = "
    ];
    for (let i = 0; i < markers.length; i++) {
      const idx = text.indexOf(markers[i]);
      if (idx !== -1) return idx + markers[i].length;
    }
    return -1;
  }

  function findMatchingClosingBrace(text, startIdx) {
    let idx = startIdx;
    while (idx < text.length && text.charCodeAt(idx) <= 32) {
      idx++;
    }
    if (idx >= text.length || text.charCodeAt(idx) !== 123) { // 123 is '{'
      return -1;
    }

    let braceCount = 0;
    let inString = false;
    let escape = false;

    for (let i = idx; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (escape) {
        escape = false;
        continue;
      }
      if (c === 92) { // '\\'
        escape = true;
        continue;
      }
      if (c === 34) { // '"'
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (c === 123) { // '{'
          braceCount++;
        } else if (c === 125) { // '}'
          braceCount--;
          if (braceCount === 0) {
            return i;
          }
        }
      }
    }
    return -1;
  }

  function isArabicTrack(t) {
    const id = (t.id || '').toLowerCase();
    const name = (t.displayName || '').toLowerCase();
    return (
      id.startsWith('ar.') ||
      id.startsWith('ar-') ||
      id === 'ar' ||
      id.includes('.ar.') ||
      id.endsWith('.ar') ||
      name.includes('arabic') ||
      name.includes('العربية') ||
      name.includes('عربي')
    );
  }

  function isOriginalLanguageTrack(t) {
    const id = (t.id || '').toLowerCase();
    const name = (t.displayName || '').toLowerCase();
    return (
      id.endsWith('.4') ||
      name.includes('أصلي') ||
      name.includes('اصلي') ||
      name.includes('original')
    );
  }

  async function extractVideoAudioTracks(videoId) {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const controller = new AbortController();

    try {
      const response = await fetch(watchUrl, {
        method: 'GET',
        credentials: 'same-origin',
        signal: controller.signal
      });

      if (!response.ok) {
        return { isDubbed: false };
      }

      let foundJson = null;

      // Stream Early-Abort: read only the first ~120KB and abort remaining 1.5MB HTML!
      if (response.body && response.body.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const sIdx = findStartMarker(buffer);
            if (sIdx !== -1) {
              const eIdx = findMatchingClosingBrace(buffer, sIdx);
              if (eIdx !== -1) {
                foundJson = buffer.substring(sIdx, eIdx + 1);
                controller.abort(); // STOP DOWNLOADING IMMEDIATELY!
                break;
              }
            }

            // Safety limit: if buffer exceeds 400KB without finding closing brace
            if (buffer.length > 400000) {
              controller.abort();
              break;
            }
          }
        } catch (readErr) {
          // Expected when aborted via controller.abort()
        }
      } else {
        const text = await response.text();
        const sIdx = findStartMarker(text);
        if (sIdx !== -1) {
          const eIdx = findMatchingClosingBrace(text, sIdx);
          if (eIdx !== -1) {
            foundJson = text.substring(sIdx, eIdx + 1);
          }
        }
      }

      if (!foundJson) {
        return { isDubbed: false };
      }

      // Fast string pre-filter: does the payload even contain Arabic?
      const lower = foundJson.toLowerCase();
      if (
        !lower.includes('ar.') &&
        !lower.includes('ar-') &&
        !lower.includes('"ar"') &&
        !lower.includes('.ar.') &&
        !lower.includes('arabic') &&
        !lower.includes('العربية') &&
        !lower.includes('عربي')
      ) {
        return {
          isDubbed: false,
          timestamp: Date.now()
        };
      }

      const playerData = JSON.parse(foundJson);
      const audioTracksMap = new Map();

      if (playerData.streamingData?.adaptiveFormats) {
        for (const format of playerData.streamingData.adaptiveFormats) {
          if (format.mimeType && format.mimeType.startsWith('audio/') && format.audioTrack) {
            const trackId = (format.audioTrack.audioTrackId || format.audioTrack.id || '').trim();
            const displayName = (format.audioTrack.displayName || '').trim();
            if (trackId || displayName) {
              const key = (trackId || displayName).toLowerCase();
              const existing = audioTracksMap.get(key);
              if (!existing || (!existing.displayName && displayName)) {
                audioTracksMap.set(key, { id: trackId, displayName });
              }
            }
          }
        }
      }

      if (playerData.captions?.playerCaptionsTracklistRenderer?.audioTracks) {
        for (const t of playerData.captions.playerCaptionsTracklistRenderer.audioTracks) {
          if (t.audioTrackId && typeof t.audioTrackId === 'string') {
            const trackId = t.audioTrackId.trim();
            const displayName = (t.displayName || '').trim();
            const key = trackId.toLowerCase();
            if (!audioTracksMap.has(key)) {
              audioTracksMap.set(key, { id: trackId, displayName });
            }
          }
        }
      }

      const audioTracks = [...audioTracksMap.values()];
      const totalAudioTracks = audioTracks.length;
      const arabicTracks = audioTracks.filter(isArabicTrack);
      const isOriginallyArabic = arabicTracks.some(isOriginalLanguageTrack);

      const isDubbed = totalAudioTracks >= 2 && arabicTracks.length > 0 && !isOriginallyArabic;

      return {
        isDubbed: isDubbed,
        timestamp: Date.now()
      };
    } catch (err) {
      return { isDubbed: false };
    }
  }

  // ==========================================
  // 3. Multi-Worker Priority Queue
  // ==========================================

  function processQueue() {
    while (activeWorkers < CONCURRENT_LIMIT) {
      // Pick visible videos first (high priority), then pre-fetch zone
      const videoId = highPriorityQueue.shift() || lowPriorityQueue.shift();
      if (!videoId) break;

      activeWorkers++;
      runWorker(videoId);
    }
  }

  async function runWorker(videoId) {
    try {
      const result = await extractVideoAudioTracks(videoId);
      setCacheEntry(videoId, result);
      saveCache();

      const waiting = pendingPromises.get(videoId);
      if (waiting) {
        for (let i = 0; i < waiting.length; i++) {
          waiting[i](result);
        }
        pendingPromises.delete(videoId);
      }
    } catch (err) {
      const fallback = { isDubbed: false };
      setCacheEntry(videoId, fallback);
      const waiting = pendingPromises.get(videoId);
      if (waiting) {
        for (let i = 0; i < waiting.length; i++) {
          waiting[i](fallback);
        }
        pendingPromises.delete(videoId);
      }
    } finally {
      activeWorkers--;
      processQueue();
    }
  }

  function requestVideoCheck(videoId, isVisibleNow = false) {
    if (memoryCache.has(videoId)) {
      return Promise.resolve(memoryCache.get(videoId));
    }

    if (pendingPromises.has(videoId)) {
      // If video just scrolled into view, prioritize it ahead of off-screen items!
      if (isVisibleNow) {
        const lowIdx = lowPriorityQueue.indexOf(videoId);
        if (lowIdx !== -1) {
          lowPriorityQueue.splice(lowIdx, 1);
          if (!highPriorityQueue.includes(videoId)) {
            highPriorityQueue.push(videoId);
            processQueue();
          }
        }
      }
      return new Promise(resolve => {
        pendingPromises.get(videoId).push(resolve);
      });
    }

    return new Promise(resolve => {
      pendingPromises.set(videoId, [resolve]);

      if (isVisibleNow) {
        if (!highPriorityQueue.includes(videoId)) {
          highPriorityQueue.push(videoId); // Natural top-to-bottom reading order!
        }
      } else {
        if (!lowPriorityQueue.includes(videoId) && !highPriorityQueue.includes(videoId)) {
          lowPriorityQueue.push(videoId);
        }
      }

      processQueue();
    });
  }

  // ==========================================
  // 4. Viewport Observer (1000px Pre-Fetch Margin)
  // ==========================================

  const thumbnailObserver = new IntersectionObserver((entries, observer) => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.isIntersecting) {
        const link = entry.target;
        observer.unobserve(link);

        const rect = link.getBoundingClientRect();
        const vHeight = window.innerHeight || document.documentElement.clientHeight;
        const isVisibleNow = rect.top < vHeight && rect.bottom > 0;

        checkThumbnail(link, isVisibleNow);
      }
    }
  }, {
    rootMargin: '1000px 0px 1000px 0px', // 1000px pre-fetch buffer
    threshold: 0
  });

  function extractVideoIdFromElement(el) {
    const href = el.getAttribute('href') || el.href || '';
    if (!href || href.includes('/shorts/')) return null;
    const match = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/i);
    return match ? match[1] : null;
  }

  function checkThumbnail(link, isVisibleNow = false) {
    if (SETTINGS.isEnabled === false) return;
    const videoId = extractVideoIdFromElement(link);
    if (!videoId) return;

    if (link.dataset.ytDubVideoId === videoId && link.dataset.ytDubStatus === 'done') {
      return;
    }

    // Instant Synchronous Cache Hit (0ms)
    if (memoryCache.has(videoId)) {
      link.dataset.ytDubVideoId = videoId;
      link.dataset.ytDubStatus = 'done';
      const cached = memoryCache.get(videoId);
      if (cached && cached.isDubbed) {
        injectBadge(link);
      }
      return;
    }

    link.dataset.ytDubVideoId = videoId;
    link.dataset.ytDubStatus = 'checking';

    requestVideoCheck(videoId, isVisibleNow).then(result => {
      if (SETTINGS.isEnabled === false) return;
      if (extractVideoIdFromElement(link) !== videoId) return;

      link.dataset.ytDubStatus = 'done';
      if (result && result.isDubbed) {
        injectBadge(link);
      }
    });
  }

  // ==========================================
  // 5. Universal Badge Injection
  // ==========================================

  function injectBadge(link) {
    if (SETTINGS.isEnabled === false) return;
    if (link.querySelector('.yt-ar-dub-badge')) return;

    const badge = document.createElement('div');
    badge.className = `yt-ar-dub-badge ${SETTINGS.badgePosition === 'left' ? 'yt-ar-left' : ''}`;
    badge.setAttribute('data-theme', SETTINGS.badgeTheme || 'indigo');
    badge.setAttribute('title', 'مدبلج باللغة العربية');

    badge.innerHTML = `
      <span class="yt-ar-dub-icon-wrap">${HEADSET_SVG}</span>
      <span class="yt-ar-dub-text">${SETTINGS.badgeText}</span>
    `;

    // Modern Wiz layout (yt-lockup-view-model / yt-thumbnail-view-model)
    const newThumbModel = link.querySelector('yt-thumbnail-view-model') ||
                          link.closest('yt-lockup-view-model')?.querySelector('yt-thumbnail-view-model') ||
                          link.closest('yt-thumbnail-view-model');
    if (newThumbModel) {
      if (newThumbModel.querySelector('.yt-ar-dub-badge')) return;
      newThumbModel.appendChild(badge);
      return;
    }

    // Classic Polymer layout (#overlays)
    const overlays = link.querySelector('#overlays');
    if (overlays) {
      if (overlays.querySelector('.yt-ar-dub-badge')) return;
      overlays.appendChild(badge);
      return;
    }

    // Classic Polymer thumbnail container
    const ytdThumb = link.closest('ytd-thumbnail') || link.querySelector('ytd-thumbnail');
    if (ytdThumb) {
      if (ytdThumb.querySelector('.yt-ar-dub-badge')) return;
      ytdThumb.appendChild(badge);
      return;
    }

    link.appendChild(badge);
  }

  // ==========================================
  // 6. Fast-Response Thumbnail Scanner (40ms Debounce)
  // ==========================================

  function isThumbnailAnchor(a) {
    if (a.id === 'video-title' || a.id === 'video-title-link' || a.id === 'avatar-link') return false;
    if (a.closest('#avatar, #author-thumbnail, yt-avatar-shape')) return false;

    if (a.id === 'thumbnail') return true;
    if (typeof a.className === 'string' && (
      a.className.includes('content-image') ||
      a.className.includes('thumbnail')
    )) return true;
    if (a.closest('ytd-thumbnail, yt-thumbnail-view-model')) return true;
    if (a.querySelector('yt-thumbnail-view-model, ytd-thumbnail, yt-image, img')) return true;

    return false;
  }

  function scanThumbnails() {
    if (SETTINGS.isEnabled === false) {
      document.querySelectorAll('.yt-ar-dub-badge').forEach(b => b.remove());
      return;
    }

    const anchors = document.querySelectorAll('a[href*="/watch?v="]');
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (!isThumbnailAnchor(a)) continue;

      const videoId = extractVideoIdFromElement(a);
      if (!videoId) continue;

      // 1. Skip if already badged
      if (a.dataset.ytDubStatus === 'done' && a.dataset.ytDubVideoId === videoId) {
        continue;
      }

      // 2. Instant Synchronous Cache Hit (0ms)
      if (memoryCache.has(videoId)) {
        a.dataset.ytDubVideoId = videoId;
        a.dataset.ytDubStatus = 'done';
        a.dataset.ytDubObservedId = videoId;
        const cached = memoryCache.get(videoId);
        if (cached && cached.isDubbed) {
          injectBadge(a);
        }
        continue;
      }

      // 3. New video: Observe with 1000px buffer
      if (a.dataset.ytDubObservedId !== videoId) {
        a.dataset.ytDubObservedId = videoId;
        a.dataset.ytDubStatus = '';
        thumbnailObserver.observe(a);
      }
    }
  }

  // Fast 40ms debounce
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanThumbnails();
    }, 40);
  }

  // ==========================================
  // 7. Initialization & Settings Listeners
  // ==========================================

  loadCache();

  try {
    browserAPI.storage.local.get(['yt_dub_settings'], (res) => {
      if (res && res.yt_dub_settings) {
        Object.assign(SETTINGS, res.yt_dub_settings);
      }
      scanThumbnails();
    });

    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.yt_dub_settings?.newValue) {
        const wasEnabled = SETTINGS.isEnabled !== false;
        Object.assign(SETTINGS, changes.yt_dub_settings.newValue);
        const isEnabledNow = SETTINGS.isEnabled !== false;

        if (wasEnabled && !isEnabledNow) {
          // Extension turned off: immediately remove all badges
          document.querySelectorAll('.yt-ar-dub-badge').forEach(badge => badge.remove());
          return;
        }

        if (!wasEnabled && isEnabledNow) {
          // Extension turned on: immediately scan and restore badges
          scanThumbnails();
          return;
        }

        if (!isEnabledNow) return;

        document.querySelectorAll('.yt-ar-dub-badge').forEach(badge => {
          if (SETTINGS.badgePosition === 'left') {
            badge.classList.add('yt-ar-left');
          } else {
            badge.classList.remove('yt-ar-left');
          }
          badge.setAttribute('data-theme', SETTINGS.badgeTheme || 'indigo');
          const textEl = badge.querySelector('.yt-ar-dub-text');
          if (textEl) textEl.textContent = SETTINGS.badgeText;
        });
      }
    });
  } catch (e) {
    scanThumbnails();
  }

  window.addEventListener('yt-navigate-finish', scheduleScan);
  window.addEventListener('yt-page-data-updated', scheduleScan);
  setInterval(scheduleScan, 1500);

  const domObserver = new MutationObserver(scheduleScan);

  if (document.body) {
    domObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      domObserver.observe(document.body, { childList: true, subtree: true });
    });
  }

})();
