/**
 * db.js — IndexedDB Storage Layer
 * Handles all persistent storage: images, metadata, settings, history
 * Uses a single "snappdf" database with multiple object stores
 */

const DB = (() => {
  const DB_NAME = 'snappdf_v2';
  const DB_VERSION = 1;
  let _db = null;

  // ---- STORES ----
  const STORES = {
    IMAGES: 'images',       // { id, blob, name, size, w, h, rotation, flipH, flipV, addedAt, order }
    META:   'meta',         // project metadata { key: value }
    HISTORY: 'history',     // undo/redo stacks as JSON
  };

  function sanitizeImageRecord(record) {
    if (!record) return record;
    const { _thumbDataURL, ...stored } = record;
    return stored;
  }

  function normalizeDBError(error) {
    if (!error) return new Error('IndexedDB operation failed');
    if (isQuotaError(error)) {
      const quotaError = new Error('Storage full. Try reducing image size or clearing project');
      quotaError.name = 'QuotaExceededError';
      quotaError.cause = error;
      return quotaError;
    }
    return error;
  }

  function isQuotaError(error) {
    return error?.name === 'QuotaExceededError'
      || error?.code === 22
      || error?.code === 1014
      || /quota/i.test(error?.message || '');
  }

  function isValidImageRecord(record) {
    return !!(record
      && typeof record.id === 'string'
      && typeof record.order === 'number'
      && record.blob instanceof Blob);
  }

  /** Open (or upgrade) the database */
  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains(STORES.IMAGES)) {
          const imgStore = db.createObjectStore(STORES.IMAGES, { keyPath: 'id' });
          imgStore.createIndex('order', 'order', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.META)) {
          db.createObjectStore(STORES.META, { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains(STORES.HISTORY)) {
          db.createObjectStore(STORES.HISTORY, { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => {
        _db = e.target.result;
        _db.onversionchange = () => {
          _db.close();
          _db = null;
        };
        resolve(_db);
      };

      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
  }

  /** Generic transaction helper */
  function tx(stores, mode, fn) {
    return open().then(db => {
      return new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(normalizeDBError(t.error || new Error('IndexedDB transaction failed')));
        t.onabort = () => reject(normalizeDBError(t.error || new Error('IndexedDB transaction aborted')));

        try {
          result = fn(t);
          if (mode === 'readonly') {
            Promise.resolve(result)
              .then(value => { result = value; })
              .catch(reject);
          }
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /** Wrap an IDBRequest in a promise */
  function req2p(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(normalizeDBError(r.error));
    });
  }

  // ---- IMAGES ----

  /** Save (add or update) an image record */
  async function saveImage(record) {
    return tx(STORES.IMAGES, 'readwrite', t =>
      req2p(t.objectStore(STORES.IMAGES).put(sanitizeImageRecord(record)))
    );
  }

  /** Save multiple image records in one transaction */
  async function saveImages(records) {
    return tx(STORES.IMAGES, 'readwrite', t => {
      const store = t.objectStore(STORES.IMAGES);
      return Promise.all(records.map(record => req2p(store.put(sanitizeImageRecord(record)))));
    });
  }

  /** Get all images, sorted by .order */
  async function getAllImages() {
    return tx(STORES.IMAGES, 'readonly', t =>
      req2p(t.objectStore(STORES.IMAGES).getAll())
    ).then(rows => rows
      .filter(isValidImageRecord)
      .sort((a, b) => a.order - b.order));
  }

  /** Get a single image by id */
  async function getImage(id) {
    return tx(STORES.IMAGES, 'readonly', t =>
      req2p(t.objectStore(STORES.IMAGES).get(id))
    );
  }

  /** Delete an image by id */
  async function deleteImage(id) {
    return tx(STORES.IMAGES, 'readwrite', t =>
      req2p(t.objectStore(STORES.IMAGES).delete(id))
    );
  }

  /** Delete all images */
  async function clearImages() {
    return tx(STORES.IMAGES, 'readwrite', t =>
      req2p(t.objectStore(STORES.IMAGES).clear())
    );
  }

  /** Count images */
  async function countImages() {
    return tx(STORES.IMAGES, 'readonly', t =>
      req2p(t.objectStore(STORES.IMAGES).count())
    );
  }

  /** Batch update orders — takes array of {id, order} */
  async function batchUpdateOrder(updates) {
    return tx(STORES.IMAGES, 'readwrite', t => {
      const store = t.objectStore(STORES.IMAGES);
      return Promise.all(updates.map(async ({ id, order }) => {
        const record = await req2p(store.get(id));
        if (record) {
          record.order = order;
          await req2p(store.put(record));
        }
      }));
    });
  }

  // ---- META ----

  async function setMeta(key, value) {
    return tx(STORES.META, 'readwrite', t =>
      req2p(t.objectStore(STORES.META).put({ key, value }))
    );
  }

  async function getMeta(key) {
    return tx(STORES.META, 'readonly', t =>
      req2p(t.objectStore(STORES.META).get(key))
    ).then(r => r ? r.value : null);
  }

  async function clearMeta() {
    return tx(STORES.META, 'readwrite', t =>
      req2p(t.objectStore(STORES.META).clear())
    );
  }

  // ---- HISTORY (undo/redo) ----

  async function saveHistory(undoStack, redoStack) {
    return tx(STORES.HISTORY, 'readwrite', t => {
      const store = t.objectStore(STORES.HISTORY);
      return Promise.all([
        req2p(store.put({ key: 'undo', value: undoStack })),
        req2p(store.put({ key: 'redo', value: redoStack })),
      ]);
    });
  }

  async function loadHistory() {
    return tx(STORES.HISTORY, 'readonly', async t => {
      const store = t.objectStore(STORES.HISTORY);
      const [undo, redo] = await Promise.all([
        req2p(store.get('undo')),
        req2p(store.get('redo')),
      ]);
      return {
        undo: normalizeHistoryValue(undo?.value),
        redo: normalizeHistoryValue(redo?.value),
      };
    });
  }

  // ---- EXPORT / IMPORT ALL ----

  /** Export all image blobs as base64 + metadata for project JSON */
  async function exportProjectJSON(projectName, pdfSettings) {
    const images = await getAllImages();
    const records = await Promise.all(images.map(async img => {
      const base64 = await blobToBase64(img.blob);
      return {
        ...sanitizeImageRecord(img),
        blobBase64: base64,
        blobType: img.blob?.type || 'image/png',
        blob: undefined,
      };
    }));
    return {
      version: 2,
      projectName,
      pdfSettings,
      exportedAt: new Date().toISOString(),
      images: records,
    };
  }

  /** Import a project JSON safely */
  async function importProjectJSON(json) {
    const images = await Promise.all((json.images || []).map(async img => {
      const type = img.blobType || detectBlobType(img.blobBase64) || 'image/png';
      const blob = base64ToBlob(img.blobBase64, type);
      const { blobBase64, blobType, ...rest } = img;
      return { ...rest, blob };
    })).then(records => records.filter(isValidImageRecord));

    return replaceProjectData({
      images,
      meta: {
        projectName: json.projectName || '',
        pdfSettings: json.pdfSettings || null,
      },
      undoStack: [],
      redoStack: [],
    });
  }

  async function replaceProjectData({ images = [], meta = {}, undoStack = [], redoStack = [] }) {
    return tx([STORES.IMAGES, STORES.META, STORES.HISTORY], 'readwrite', t => {
      const imageStore = t.objectStore(STORES.IMAGES);
      const metaStore = t.objectStore(STORES.META);
      const historyStore = t.objectStore(STORES.HISTORY);

      return Promise.all([
        req2p(imageStore.clear()),
        req2p(metaStore.clear()),
        req2p(historyStore.clear()),
      ]).then(async () => {
        for (const image of images) {
          await req2p(imageStore.put(sanitizeImageRecord(image)));
        }

        for (const [key, value] of Object.entries(meta)) {
          if (value !== undefined && value !== null && value !== '') {
            await req2p(metaStore.put({ key, value }));
          }
        }

        await req2p(historyStore.put({ key: 'undo', value: undoStack }));
        await req2p(historyStore.put({ key: 'redo', value: redoStack }));
      });
    });
  }

  // ---- HELPERS ----

  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }

  function base64ToBlob(dataURL, type) {
    const b64 = dataURL.split(',')[1];
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type });
  }

  function detectBlobType(dataURL) {
    const match = /^data:([^;]+);base64,/.exec(dataURL || '');
    return match ? match[1] : null;
  }

  function normalizeHistoryValue(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  // Generate a unique ID
  function generateId() {
    return `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  return {
    open,
    sanitizeImageRecord,
    saveImage,
    saveImages,
    getAllImages,
    getImage,
    deleteImage,
    clearImages,
    countImages,
    batchUpdateOrder,
    setMeta,
    getMeta,
    clearMeta,
    saveHistory,
    loadHistory,
    exportProjectJSON,
    importProjectJSON,
    replaceProjectData,
    isQuotaError,
    isValidImageRecord,
    blobToBase64,
    base64ToBlob,
    generateId,
  };
})();
