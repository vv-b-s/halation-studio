import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveUploadedImageToCache,
  loadUploadedImageFromCache,
  saveStudioStateToCache,
  loadStudioStateFromCache,
  clearStudioCache,
} from '../session-cache.js';

/**
 * In-memory mock for IndexedDB and localStorage so session-cache.js can be
 * tested exhaustively across both IndexedDB and localStorage fallback paths.
 */
function createStorageMocks({ failIndexedDB = false } = {}) {
  const idbMap = new Map();
  const lsMap = new Map();

  const localStorageMock = {
    getItem(k) {
      return lsMap.has(k) ? lsMap.get(k) : null;
    },
    setItem(k, v) {
      lsMap.set(k, String(v));
    },
    removeItem(k) {
      lsMap.delete(k);
    },
  };

  const indexedDBMock = failIndexedDB
    ? undefined
    : {
        open() {
          const req = {
            result: {
              objectStoreNames: {
                contains() {
                  return false;
                },
              },
              createObjectStore() {},
              transaction() {
                const tx = {
                  objectStore() {
                    return {
                      put(val, key) {
                        idbMap.set(key, val);
                        setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
                      },
                      get(key) {
                        const getReq = { result: idbMap.get(key) };
                        setTimeout(() => getReq.onsuccess && getReq.onsuccess(), 0);
                        return getReq;
                      },
                      delete(key) {
                        idbMap.delete(key);
                        setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
                      },
                    };
                  },
                };
                return tx;
              },
              close() {},
            },
          };
          setTimeout(() => {
            if (req.onupgradeneeded) req.onupgradeneeded();
            if (req.onsuccess) req.onsuccess();
          }, 0);
          return req;
        },
      };

  return { idbMap, lsMap, localStorageMock, indexedDBMock };
}

test('session-cache saves, loads, and clears uploaded images and studio state via IndexedDB', async () => {
  const { idbMap, lsMap, localStorageMock, indexedDBMock } = createStorageMocks();
  const prevIDB = globalThis.indexedDB;
  const prevLS = globalThis.localStorage;
  globalThis.indexedDB = indexedDBMock;
  globalThis.localStorage = localStorageMock;

  try {
    const sampleBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) sampleBytes[i] = i;

    const fakeFile = new File([sampleBytes], 'Night_Roll_04.jpg', {
      type: 'image/jpeg',
      lastModified: 1711111111000,
    });

    // Seed legacy v1 keys to verify loadUploadedImageFromCache purges stale GPS-redacted v1 cache entries
    idbMap.set('lastUploadedImage', { name: 'stale.jpg' });
    lsMap.set('halation_studio_image_v1', '{"name":"stale.jpg"}');

    const savedImg = await saveUploadedImageToCache(fakeFile, sampleBytes);
    assert.equal(savedImg, true);
    assert.ok(idbMap.has('lastUploadedImage_v2'));
    assert.ok(lsMap.has('halation_studio_image_v2'));

    const loadedImg = await loadUploadedImageFromCache();
    assert.ok(loadedImg);
    assert.equal(idbMap.has('lastUploadedImage'), false);
    assert.equal(lsMap.has('halation_studio_image_v1'), false);
    assert.equal(loadedImg.name, 'Night_Roll_04.jpg');
    assert.equal(loadedImg.type, 'image/jpeg');
    assert.equal(loadedImg.lastModified, 1711111111000);
    assert.deepEqual(loadedImg.bytes, sampleBytes);
    assert.equal(loadedImg.file.name, 'Night_Roll_04.jpg');

    // Save & load studio state
    const stateToSave = {
      params: { strength: 162, radius: 22, stripMetadata: false },
      activePresetKey: 'vision3Remjet',
      currentSampleKey: 'custom',
      viewMode: 'split-input',
      splitPercent: 45,
      exportMime: 'image/jpeg',
      exportExt: 'jpg',
    };
    const savedState = await saveStudioStateToCache(stateToSave);
    assert.equal(savedState, true);

    const loadedState = await loadStudioStateFromCache();
    assert.equal(loadedState.params.strength, 162);
    assert.equal(loadedState.activePresetKey, 'vision3Remjet');
    assert.equal(loadedState.currentSampleKey, 'custom');
    assert.equal(loadedState.splitPercent, 45);

    // Clear studio cache
    await clearStudioCache();
    assert.equal(await loadUploadedImageFromCache(), null);
    assert.equal(await loadStudioStateFromCache(), null);
  } finally {
    globalThis.indexedDB = prevIDB;
    globalThis.localStorage = prevLS;
  }
});

test('session-cache falls back cleanly to localStorage when IndexedDB is unavailable', async () => {
  const { localStorageMock } = createStorageMocks({ failIndexedDB: true });
  const prevIDB = globalThis.indexedDB;
  const prevLS = globalThis.localStorage;
  delete globalThis.indexedDB;
  globalThis.localStorage = localStorageMock;

  try {
    const sampleBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 10, 20, 30]);
    const file = new File([sampleBytes], 'fallback_photo.png', { type: 'image/png' });

    await saveUploadedImageToCache(file);
    const loaded = await loadUploadedImageFromCache();
    assert.ok(loaded);
    assert.equal(loaded.name, 'fallback_photo.png');
    assert.equal(loaded.type, 'image/png');
    assert.deepEqual(loaded.bytes, sampleBytes);

    await saveStudioStateToCache({ currentSampleKey: 'custom', splitPercent: 60 });
    const state = await loadStudioStateFromCache();
    assert.equal(state.currentSampleKey, 'custom');
    assert.equal(state.splitPercent, 60);

    await clearStudioCache();
    assert.equal(await loadUploadedImageFromCache(), null);
    assert.equal(await loadStudioStateFromCache(), null);
  } finally {
    globalThis.indexedDB = prevIDB;
    globalThis.localStorage = prevLS;
  }
});
