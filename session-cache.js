/**
 * Halation Optical Studio — Persistent Session & Uploaded Image Cache
 *
 * Caches the last uploaded image (raw binary bytes + exact filename + MIME type)
 * and the user's current studio parameters/toggle state in IndexedDB (with a
 * localStorage fallback) so an accidental browser refresh restores the exact
 * photo, metadata, filename, and slider/toggle settings.
 */

const DB_NAME = 'HalationStudioCacheDB';
const DB_VERSION = 1;
const STORE_NAME = 'sessionStore';
const IMAGE_KEY = 'lastUploadedImage_v2';
const LEGACY_IMAGE_KEY = 'lastUploadedImage';
const STATE_KEY = 'studioState';

const LS_STATE_KEY = 'halation_studio_state_v1';
const LS_IMAGE_KEY = 'halation_studio_image_v2';
const LEGACY_LS_IMAGE_KEY = 'halation_studio_image_v1';
const MAX_LS_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB fallback threshold for localStorage

function openCacheDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

function idbPut(key, value) {
  return openCacheDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(value, key);
        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

function idbGet(key) {
  return openCacheDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          db.close();
          resolve(req.result ?? null);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      })
  );
}

function idbDelete(key) {
  return openCacheDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

function uint8ToBase64(u8) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Caches the last uploaded image's exact binary bytes, filename, and MIME type.
 */
export async function saveUploadedImageToCache(fileOrRecord, rawBytes) {
  const bytes =
    rawBytes instanceof Uint8Array
      ? rawBytes
      : new Uint8Array(rawBytes || (await fileOrRecord.arrayBuffer()));

  const record = {
    name: fileOrRecord.name || 'photo.png',
    type: fileOrRecord.type || 'image/png',
    lastModified: fileOrRecord.lastModified || Date.now(),
    savedAt: Date.now(),
    bytes: bytes.slice(), // detached Uint8Array copy for structured clone
  };

  // Save in localStorage as immediate synchronous fallback when <= 2 MB
  try {
    if (typeof localStorage !== 'undefined' && bytes.byteLength <= MAX_LS_IMAGE_BYTES) {
      localStorage.setItem(
        LS_IMAGE_KEY,
        JSON.stringify({
          name: record.name,
          type: record.type,
          lastModified: record.lastModified,
          savedAt: record.savedAt,
          base64: uint8ToBase64(bytes),
        })
      );
    }
  } catch (_) {
    // Ignore localStorage quota errors; IndexedDB handles large files
  }

  try {
    await idbPut(IMAGE_KEY, record);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Loads the last uploaded image from cache (IndexedDB first, localStorage fallback).
 * Returns { name, type, lastModified, bytes: Uint8Array, file: File } or null.
 */
export async function loadUploadedImageFromCache() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LEGACY_LS_IMAGE_KEY);
    }
  } catch (_) {}
  idbDelete(LEGACY_IMAGE_KEY).catch(() => {});

  let record = null;
  try {
    record = await idbGet(IMAGE_KEY);
  } catch (_) {
    record = null;
  }

  if (!record || !record.bytes) {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(LS_IMAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.base64) {
            record = {
              name: parsed.name || 'photo.png',
              type: parsed.type || 'image/png',
              lastModified: parsed.lastModified || Date.now(),
              savedAt: parsed.savedAt || Date.now(),
              bytes: base64ToUint8(parsed.base64),
            };
          }
        }
      }
    } catch (_) {
      record = null;
    }
  }

  if (!record || !record.bytes) return null;

  const u8 =
    record.bytes instanceof Uint8Array
      ? record.bytes
      : new Uint8Array(record.bytes);

  let file = null;
  if (typeof File !== 'undefined') {
    file = new File([u8], record.name, {
      type: record.type,
      lastModified: record.lastModified,
    });
  }

  return {
    name: record.name,
    type: record.type,
    lastModified: record.lastModified,
    bytes: u8,
    file,
  };
}

/**
 * Saves studio UI & parameter state so refreshing restores exact settings.
 */
export async function saveStudioStateToCache(state) {
  const payload = {
    ...state,
    savedAt: Date.now(),
  };

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_STATE_KEY, JSON.stringify(payload));
    }
  } catch (_) {
    // Ignore localStorage quota errors
  }

  try {
    await idbPut(STATE_KEY, payload);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Loads studio UI & parameter state from cache.
 */
export async function loadStudioStateFromCache() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(LS_STATE_KEY);
      if (raw) {
        return JSON.parse(raw);
      }
    }
  } catch (_) {
    // Fall through to IndexedDB
  }

  try {
    return await idbGet(STATE_KEY);
  } catch (_) {
    return null;
  }
}

/**
 * Clears cached image and studio state.
 */
export async function clearStudioCache() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LS_STATE_KEY);
      localStorage.removeItem(LS_IMAGE_KEY);
      localStorage.removeItem(LEGACY_LS_IMAGE_KEY);
    }
  } catch (_) {}
  try {
    await idbDelete(IMAGE_KEY);
    await idbDelete(LEGACY_IMAGE_KEY);
    await idbDelete(STATE_KEY);
  } catch (_) {}
}
