/**
 * YouTube Arabic Dub Indicator - Background Coordinator
 * Uses robust multi-source extraction, two-tier cache, and concurrency queue.
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// In-Memory Cache for 0ms lookup
const memoryCache = new Map();

// Configuration
const CONFIG = {
  CACHE_STORAGE_KEY: 'yt_dub_cache_v6',
  CACHE_TTL_DAYS: 21,
  MAX_CACHE_ENTRIES: 5000,
  CONCURRENT_LIMIT: 4,
  REQUEST_DELAY_MS: 30,
  CACHE_SAVE_DEBOUNCE_MS: 2000
};

// Queue system
const taskQueue = [];
let activeWorkers = 0;
const pendingPromises = new Map();
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
    // Clear old legacy caches
    await browserAPI.storage.local.remove([
      'yt_dub_cache_v1',
      'yt_dub_cache_v2',
      'yt_dub_cache_v3',
      'yt_dub_cache_v4',
      'yt_dub_cache_v5'
    ]);

    const data = await browserAPI.storage.local.get([CONFIG.CACHE_STORAGE_KEY, 'yt_dub_stats_v2']);
    if (data[CONFIG.CACHE_STORAGE_KEY]) {
      const stored = data[CONFIG.CACHE_STORAGE_KEY];
      const now = Date.now();
      const ttlMs = CONFIG.CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

      for (const [id, info] of Object.entries(stored)) {
        if (info && (now - (info.timestamp || 0)) < ttlMs) {
          memoryCache.set(id, info);
          if (info.isDubbed || info.hasArabicDub) {
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
// 2. Video Track Extraction Engine
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

async function extractVideoAudioTracks(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let response;

  try {
    response = await fetch(watchUrl, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ar,en;q=0.9'
      },
      credentials: 'include'
    });
  } catch (err) {
    console.warn('[YT-Arabic-Dub] Fetch error for', videoId, ':', err);
    return { hasArabicDub: false, isDubbed: false, tracksCount: 0, error: err.message };
  }

  if (!response.ok) {
    return { hasArabicDub: false, isDubbed: false, tracksCount: 0 };
  }

  const text = await response.text();
  const tracks = extractTracksFromText(text);

  const arabicTracks = tracks.filter(isArabicTrack);
  const hasArabic = arabicTracks.length > 0;
  const isOriginallyArabic = arabicTracks.some(isOriginalLanguageTrack);
  const hasAutoDubbed = arabicTracks.some(t => t.isAutoDubbed);

  const isDubbed = hasAutoDubbed || (tracks.length >= 2 && hasArabic && !isOriginallyArabic);

  return {
    hasArabicDub: hasArabic,
    isDubbed: isDubbed,
    tracksCount: tracks.length,
    timestamp: Date.now()
  };
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
      if (result.isDubbed) {
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
      const fallback = { hasArabicDub: false, isDubbed: false, tracksCount: 0, error: err.message };
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
    return Promise.resolve({ hasArabicDub: false, isDubbed: false, tracksCount: 0 });
  }

  if (memoryCache.has(videoId)) {
    return Promise.resolve({ ...memoryCache.get(videoId), cached: true });
  }

  if (pendingPromises.has(videoId)) {
    return new Promise((resolve, reject) => {
      pendingPromises.get(videoId).push({ resolve, reject });
    });
  }

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
      return true;
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
