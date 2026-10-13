/**
 * YouTube Arabic Dub Indicator - Background Coordinator
 * Uses robust JSON parsing, two-tier cache, and concurrency queue.
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// In-Memory Cache for 0ms lookup
const memoryCache = new Map();

// Configuration
const CONFIG = {
  CACHE_STORAGE_KEY: 'yt_dub_cache_v2', // v2 to invalidate previous failed cache
  CACHE_TTL_DAYS: 21,
  MAX_CACHE_ENTRIES: 5000,
  CONCURRENT_LIMIT: 3,
  REQUEST_DELAY_MS: 40,
  CACHE_SAVE_DEBOUNCE_MS: 2000
};

// Queue system
const taskQueue = [];
let activeWorkers = 0;
const pendingPromises = new Map(); // videoId -> Array of { resolve, reject }
let cacheSaveTimer = null;
let stats = {
  totalScanned: 0,
  dubbedFound: 0
};

// ==========================================
// 1. Storage & Cache Lifecycle
// ==========================================

async function initializeCache() {
  try {
    // Clear old v1 cache if exists to prevent stale false results
    await browserAPI.storage.local.remove(['yt_dub_cache_v1']);

    const data = await browserAPI.storage.local.get([CONFIG.CACHE_STORAGE_KEY, 'yt_dub_stats_v2']);
    if (data[CONFIG.CACHE_STORAGE_KEY]) {
      const stored = data[CONFIG.CACHE_STORAGE_KEY];
      const now = Date.now();
      const ttlMs = CONFIG.CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

      for (const [id, info] of Object.entries(stored)) {
        if (info && (now - (info.timestamp || 0)) < ttlMs) {
          memoryCache.set(id, info);
          if (info.hasArabicDub) {
            stats.dubbedFound++;
          }
        }
      }
      stats.totalScanned = memoryCache.size;
    }

    if (data.yt_dub_stats_v2) {
      stats.totalScanned = Math.max(stats.totalScanned, data.yt_dub_stats_v2.totalScanned || 0);
      stats.dubbedFound = Math.max(stats.dubbedFound, data.yt_dub_stats_v2.dubbedFound || 0);
    }

    console.log('[YT-Arabic-Dub] Initialized cache with', memoryCache.size, 'entries.');
  } catch (err) {
    console.warn('[YT-Arabic-Dub] Could not load stored cache:', err);
  }
}

function scheduleSaveCache() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(async () => {
    cacheSaveTimer = null;
    try {
      if (memoryCache.size > CONFIG.MAX_CACHE_ENTRIES) {
        const sorted = [...memoryCache.entries()].sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
        const entriesToRemove = memoryCache.size - CONFIG.MAX_CACHE_ENTRIES;
        for (let i = 0; i < entriesToRemove; i++) {
          memoryCache.delete(sorted[i][0]);
        }
      }

      const objToSave = {};
      for (const [k, v] of memoryCache.entries()) {
        objToSave[k] = v;
      }

      await browserAPI.storage.local.set({
        [CONFIG.CACHE_STORAGE_KEY]: objToSave,
        yt_dub_stats_v2: stats
      });
    } catch (e) {
      console.warn('[YT-Arabic-Dub] Cache save error:', e);
    }
  }, CONFIG.CACHE_SAVE_DEBOUNCE_MS);
}

// ==========================================
// 2. Video Track Extraction Engine (Robust Parser)
// ==========================================

async function extractVideoAudioTracks(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let response;

  try {
    response = await fetch(watchUrl, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8'
      },
      credentials: 'include'
    });
  } catch (err) {
    console.warn('[YT-Arabic-Dub] Fetch error for', videoId, ':', err);
    return { hasArabicDub: false, tracksCount: 0, error: err.message };
  }

  if (!response.ok) {
    return { hasArabicDub: false, tracksCount: 0 };
  }

  const text = await response.text();

  // Find ytInitialPlayerResponse marker
  const startMarker = 'ytInitialPlayerResponse = ';
  let startIdx = text.indexOf(startMarker);
  if (startIdx === -1) {
    const altMarker = 'var ytInitialPlayerResponse = ';
    startIdx = text.indexOf(altMarker);
    if (startIdx !== -1) startIdx += altMarker.length;
  } else {
    startIdx += startMarker.length;
  }

  if (startIdx === -1) {
    return { hasArabicDub: false, tracksCount: 0 };
  }

  // Parse JSON by tracking balanced curly brackets
  const after = text.substring(startIdx).trimStart();
  let braceCount = 0;
  let endIdx = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < after.length; i++) {
    const c = after[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (c === '{') braceCount++;
      else if (c === '}') {
        braceCount--;
        if (braceCount === 0) {
          endIdx = i;
          break;
        }
      }
    }
  }

  if (endIdx === -1) {
    return { hasArabicDub: false, tracksCount: 0 };
  }

  let playerData = null;
  try {
    const jsonStr = after.substring(0, endIdx + 1);
    playerData = JSON.parse(jsonStr);
  } catch (parseErr) {
    console.warn('[YT-Arabic-Dub] JSON parse failed for', videoId, ':', parseErr.message);
    return { hasArabicDub: false, tracksCount: 0 };
  }

  // Parse audio tracks
  const tracks = [];

  // Source A: Captions tracklist audioTracks
  if (playerData.captions?.playerCaptionsTracklistRenderer?.audioTracks) {
    for (const t of playerData.captions.playerCaptionsTracklistRenderer.audioTracks) {
      tracks.push({
        id: t.audioTrackId || t.id || '',
        displayName: t.displayName || '',
        isDefault: !!t.hasDefaultTrack
      });
    }
  }

  // Source B: Adaptive streaming formats audio tracks
  if (playerData.streamingData?.adaptiveFormats) {
    for (const format of playerData.streamingData.adaptiveFormats) {
      if (format.audioTrack) {
        tracks.push({
          id: format.audioTrack.audioTrackId || format.audioTrack.id || '',
          displayName: format.audioTrack.displayName || '',
          isDefault: !!format.audioTrack.audioIsDefault
        });
      }
    }
  }

  // Deduplicate tracks by id / name
  const uniqueTracksMap = new Map();
  for (const t of tracks) {
    const key = (t.id || t.displayName || '').toLowerCase().trim();
    if (key && !uniqueTracksMap.has(key)) {
      uniqueTracksMap.set(key, t);
    }
  }

  const uniqueTracks = [...uniqueTracksMap.values()];
  const tracksCount = uniqueTracks.length;

  // Determine if Arabic audio track exists
  const hasArabic = uniqueTracks.some(t => {
    const id = (t.id || '').toLowerCase();
    const name = (t.displayName || '').toLowerCase();
    return (
      id.startsWith('ar.') ||
      id === 'ar' ||
      id.includes('.ar.') ||
      id.endsWith('.ar') ||
      name.includes('arabic') ||
      name.includes('العربية') ||
      name.includes('عربي')
    );
  });

  const result = {
    hasArabicDub: hasArabic,
    isDubbed: hasArabic && tracksCount > 1,
    tracksCount: tracksCount,
    timestamp: Date.now()
  };

  console.log(`[YT-Arabic-Dub] Video ${videoId}: hasArabicDub = ${hasArabic} (${tracksCount} tracks)`);
  return result;
}

// ==========================================
// 3. Queue Processor with Rate Limiting
// ==========================================

function processQueue() {
  if (taskQueue.length === 0 || activeWorkers >= CONFIG.CONCURRENT_LIMIT) {
    return;
  }

  activeWorkers++;
  const videoId = taskQueue.shift();

  extractVideoAudioTracks(videoId)
    .then(result => {
      memoryCache.set(videoId, result);
      stats.totalScanned++;
      if (result.hasArabicDub) {
        stats.dubbedFound++;
      }
      scheduleSaveCache();

      const waiting = pendingPromises.get(videoId);
      if (waiting) {
        waiting.forEach(p => p.resolve(result));
        pendingPromises.delete(videoId);
      }
    })
    .catch(err => {
      const fallback = { hasArabicDub: false, tracksCount: 0, error: err.message };
      memoryCache.set(videoId, fallback);
      const waiting = pendingPromises.get(videoId);
      if (waiting) {
        waiting.forEach(p => p.resolve(fallback));
        pendingPromises.delete(videoId);
      }
    })
    .finally(() => {
      activeWorkers--;
      setTimeout(() => {
        processQueue();
      }, CONFIG.REQUEST_DELAY_MS);
    });
}

function requestVideoCheck(videoId) {
  if (!videoId || videoId.length !== 11) {
    return Promise.resolve({ hasArabicDub: false, tracksCount: 0 });
  }

  // 1. Instant Memory Cache check (0ms)
  if (memoryCache.has(videoId)) {
    return Promise.resolve({ ...memoryCache.get(videoId), cached: true });
  }

  // 2. Return existing in-flight promise if already queued
  if (pendingPromises.has(videoId)) {
    return new Promise((resolve, reject) => {
      pendingPromises.get(videoId).push({ resolve, reject });
    });
  }

  // 3. Queue new check
  return new Promise((resolve, reject) => {
    pendingPromises.set(videoId, [{ resolve, reject }]);
    taskQueue.push(videoId);
    processQueue();
  });
}

// ==========================================
// 4. Message Listeners
// ==========================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  switch (message.type) {
    case 'CHECK_VIDEO': {
      requestVideoCheck(message.videoId).then(sendResponse);
      return true; // Keep channel open for async response
    }

    case 'GET_STATS': {
      sendResponse({
        totalScanned: stats.totalScanned,
        dubbedFound: stats.dubbedFound,
        cachedVideosCount: memoryCache.size
      });
      return false;
    }

    case 'CLEAR_CACHE': {
      memoryCache.clear();
      stats.totalScanned = 0;
      stats.dubbedFound = 0;
      browserAPI.storage.local.remove([CONFIG.CACHE_STORAGE_KEY, 'yt_dub_stats_v2']).then(() => {
        sendResponse({ success: true });
      });
      return true;
    }

    default:
      return false;
  }
});

// Initialize on background startup
initializeCache();
