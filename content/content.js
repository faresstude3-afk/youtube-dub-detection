/**
 * YouTube Arabic Dub Indicator - Content Script (v1.9.0 Ultra-Resilient Engine)
 * Extreme performance & 100% accuracy optimizations:
 * 1. Hybrid Stream Scanner: Continuously inspects incoming HTML chunks and aborts
 *    as soon as an Arabic audio track is detected (saving massive bandwidth).
 * 2. 1.8MB Stream Tolerance: Never cuts off early before reading player response.
 * 3. Support for YouTube AI Auto-Dubbing (isAutoDubbed) & format variations (ar.10, ar.3, etc.).
 * 4. DOM Virtualization Watchdog: Automatically re-injects badges if YouTube's DOM recyclers detach them.
 * 5. 0ms Synchronous Cache Hit (O(1) Memory Cache + LocalStorage v6).
 * 6. Dual Priority Queue: Top-to-bottom reading order for visible thumbnails.
 */

(function () {
  'use strict';

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  console.log('[YT-Arabic-Dub] ⚡ Ultra-Resilient v1.9.0 Active');

  const SETTINGS = {
    isEnabled: true,
    badgePosition: 'right',
    badgeText: 'دبلجة عربية',
    badgeTheme: 'indigo'
  };

  // Performance Configuration
  const CACHE_KEY = 'yt_dub_cache_v6';
  const MAX_CACHE_SIZE = 500;
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
      // Purge all legacy caches to fix previously missed dubbed videos
      localStorage.removeItem('yt_dub_cache_v5');
      localStorage.removeItem('yt_dub_cache_v4');
      localStorage.removeItem('yt_dub_cache_v3');
      localStorage.removeItem('yt_dub_cache_v2');
      localStorage.removeItem('yt_dub_cache_v1');

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
  // 2. Audio Tracks Analysis Engine
  // ==========================================

  function isArabicTrack(t) {
    const id = (t.id || '').toLowerCase().trim();
    const name = (t.displayName || '').toLowerCase().trim();
    return (
      id === 'ar' ||
      id.startsWith('ar.') ||
      id.startsWith('ar-') ||
      id.startsWith('ar_') ||
      id.startsWith('ara.') ||
      id.startsWith('ara-') ||
      id.includes('.ar.') ||
      id.endsWith('.ar') ||
      name.includes('arabic') ||
      name.includes('العربية') ||
      name.includes('عربي') ||
      name.includes('arabe') ||
      name.includes('árabe') ||
      name.includes('arabisch')
    );
  }

  function isOriginalLanguageTrack(t) {
    const name = (t.displayName || '').toLowerCase();
    return (
      name.includes('أصلي') ||
      name.includes('اصلي') ||
      name.includes('original')
    );
  }

  function extractTracksFromText(text) {
    const tracksMap = new Map();

    // 1. Match all adaptiveFormats "audioTrack": { ... }
    const atRegex = /"audioTrack"\s*:\s*\{([^}]+)\}/g;
    let m;
    while ((m = atRegex.exec(text)) !== null) {
      const raw = m[1];
      const idM = raw.match(/"id"\s*:\s*"([^"]+)"/);
      const nameM = raw.match(/"displayName"\s*:\s*"([^"]+)"/);
      const defM = raw.match(/"audioIsDefault"\s*:\s*(true|false)/);
      const autoM = raw.match(/"isAutoDubbed"\s*:\s*(true|false)/);

      const id = idM ? idM[1].trim() : '';
      const displayName = nameM ? nameM[1].trim() : '';
      const isDefault = defM ? defM[1] === 'true' : false;
      const isAutoDubbed = autoM ? autoM[1] === 'true' : false;

      const key = (id || displayName).toLowerCase();
      if (key && !tracksMap.has(key)) {
        tracksMap.set(key, { id, displayName, isDefault, isAutoDubbed });
      }
    }

    // 2. Match audioTrackId in captions: "audioTrackId":"..."
    const atIdRegex = /"audioTrackId"\s*:\s*"([^"]+)"/g;
    while ((m = atIdRegex.exec(text)) !== null) {
      const id = m[1].trim();
      const key = id.toLowerCase();
      if (key && !tracksMap.has(key)) {
        tracksMap.set(key, { id, displayName: '', isDefault: false, isAutoDubbed: false });
      }
    }

    return [...tracksMap.values()];
  }

  function evaluateTracks(tracks) {
    if (!tracks || tracks.length === 0) {
      return { isDubbed: false, hasArabic: false, totalTracks: 0 };
    }

    const arabicTracks = tracks.filter(isArabicTrack);
    const hasArabic = arabicTracks.length > 0;
    const totalTracks = tracks.length;

    // Check if Arabic is explicitly labeled as the original language (e.g. "العربية: أصلي")
    const isOriginallyArabic = arabicTracks.some(isOriginalLanguageTrack);

    // AI Auto-dubbed tracks (e.g. The Infographics Show, MrBeast auto-dub)
    const hasAutoDubbedArabic = arabicTracks.some(t => t.isAutoDubbed);

    // A video is dubbed if:
    // 1. It has YouTube's isAutoDubbed flag on an Arabic track
    // 2. OR it has multiple audio tracks (>=2), Arabic is available, and Arabic is not the original language
    const isDubbed = hasAutoDubbedArabic || (totalTracks >= 2 && hasArabic && !isOriginallyArabic);

    return {
      isDubbed: isDubbed,
      hasArabic: hasArabic,
      totalTracks: totalTracks
    };
  }

  // ==========================================
  // 3. High-Speed Stream Early-Abort Fetcher
  // ==========================================

  async function extractVideoAudioTracks(videoId) {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const controller = new AbortController();

    try {
      const response = await fetch(watchUrl, {
        method: 'GET',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ar,en;q=0.9'
        }
      });

      if (!response.ok) {
        return { isDubbed: false };
      }

      let buffer = '';

      if (response.body && response.body.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Once buffer reaches ~500KB (where player response usually begins), test for dubbing
            if (buffer.length > 500000) {
              const check = evaluateTracks(extractTracksFromText(buffer));
              if (check.isDubbed) {
                controller.abort(); // FOUND ARABIC DUB! Abort immediately to save bandwidth!
                return {
                  isDubbed: true,
                  timestamp: Date.now()
                };
              }
            }

            // Safety limit: up to 1.8MB to ensure complete player response inspection
            if (buffer.length > 1800000) {
              controller.abort();
              break;
            }
          }
        } catch (readErr) {
          // Expected when aborted via controller.abort()
        }
      } else {
        buffer = await response.text();
      }

      const finalCheck = evaluateTracks(extractTracksFromText(buffer));
      return {
        isDubbed: finalCheck.isDubbed,
        timestamp: Date.now()
      };
    } catch (err) {
      return { isDubbed: false };
    }
  }

  // ==========================================
  // 4. Multi-Worker Priority Queue
  // ==========================================

  function processQueue() {
    while (activeWorkers < CONCURRENT_LIMIT) {
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
          highPriorityQueue.push(videoId);
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
  // 5. Viewport Observer (1000px Pre-Fetch Margin)
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
    rootMargin: '1000px 0px 1000px 0px',
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

    // Check if already processed
    if (link.dataset.ytDubVideoId === videoId && link.dataset.ytDubStatus === 'done') {
      const cached = memoryCache.get(videoId);
      if (cached && cached.isDubbed && !link.querySelector('.yt-ar-dub-badge')) {
        injectBadge(link);
      }
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
  // 6. Universal Badge Injection
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
  // 7. Fast-Response Thumbnail Scanner (40ms Debounce)
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

      // 1. If already processed, ensure badge is still in place (against virtual DOM removal)
      if (a.dataset.ytDubStatus === 'done' && a.dataset.ytDubVideoId === videoId) {
        const cached = memoryCache.get(videoId);
        if (cached && cached.isDubbed && !a.querySelector('.yt-ar-dub-badge')) {
          injectBadge(a);
        }
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
  // 8. Initialization & Settings Listeners
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
          document.querySelectorAll('.yt-ar-dub-badge').forEach(badge => badge.remove());
          return;
        }

        if (!wasEnabled && isEnabledNow) {
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
