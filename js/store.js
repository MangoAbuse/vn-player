// Everything that lives on the device: imported bundles, saves and settings.
//
// Bundles are kept as ONE file in the browser's private file system (OPFS) and read
// by byte range, so importing 40,000 files is a single sequential copy. Browsers
// without a writable OPFS fall back to 8 MB pieces in IndexedDB. Saves and small
// values live in IndexedDB.

import { openZip, BundleError } from './zip.js';

const DB_NAME = 'vn-player';
const STORES = ['games', 'chunks', 'saves', 'kv'];
const MB = 1024 * 1024;
let dbPromise = null;

export class StorageFullError extends Error {
  constructor(need, free) {
    super('storage full');
    this.need = need;
    this.free = free;
  }
}

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, mode);
    let result;
    const req = fn(tx.objectStore(store));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('The storage request was cancelled', 'AbortError'));
  });
}

export const idb = {
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  all: (store, range) => run(store, 'readonly', (s) => s.getAll(range)),
  put: (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key)),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  async entries(store) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = database.transaction(store, 'readonly');
      const cursor = tx.objectStore(store).openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        out.push([cursor.result.key, cursor.result.value]);
        cursor.result.continue();
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
  },
};

export const kv = {
  get: async (key, fallback) => (await idb.get('kv', key)) ?? fallback,
  set: (key, value) => idb.put('kv', key, value),
};

const gameRange = (id) => IDBKeyRange.bound([id], [id, []]);

export const saves = {
  list: (gameId) => idb.all('saves', gameRange(gameId)),
  get: (gameId, slot) => idb.get('saves', [gameId, slot]),
  put: (gameId, slot, record) => idb.put('saves', [gameId, slot], { ...record, slot }),
  del: (gameId, slot) => idb.del('saves', [gameId, slot]),
};

export async function storageInfo() {
  const info = { usage: null, quota: null, persisted: null };
  try {
    const estimate = await navigator.storage.estimate();
    info.usage = estimate.usage ?? null;
    info.quota = estimate.quota ?? null;
  } catch (_) { /* not supported */ }
  try { info.persisted = await navigator.storage.persisted(); } catch (_) { /* not supported */ }
  return info;
}

async function bundlesDir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('bundles', { create });
}

export async function listGames() {
  const games = await idb.all('games');
  return games.sort((a, b) => a.title.localeCompare(b.title));
}

export async function openGame(id) {
  const record = await idb.get('games', id);
  if (!record) throw new BundleError('missing', 'This game is not stored on this device any more.');
  let blob;
  try {
    if (record.storage === 'opfs') {
      const dir = await bundlesDir(false);
      blob = await (await dir.getFileHandle(id + '.zip')).getFile();
    } else {
      blob = new Blob(await idb.all('chunks', gameRange(id)));
    }
  } catch (_) {
    blob = null;
  }
  if (!blob || blob.size !== record.size) {
    throw new BundleError('damaged', 'The stored game data is missing or incomplete (the browser may have cleared it). Import the bundle again; your saves are kept.');
  }
  const zip = await openZip(blob);
  const manifest = await zip.json('manifest.json');
  return { id, record, zip, manifest };
}

async function removeData(id) {
  try {
    const dir = await bundlesDir(false);
    await dir.removeEntry(id + '.zip');
  } catch (_) { /* nothing stored there */ }
  try { await idb.del('chunks', gameRange(id)); } catch (_) { /* nothing stored there */ }
}

export async function deleteGame(id, { withSaves = false } = {}) {
  await removeData(id);
  await idb.del('games', id);
  if (withSaves) {
    await idb.del('saves', gameRange(id));
    await idb.del('kv', 'globals:' + id);
    await idb.del('kv', 'read:' + id);
  }
}

/** Open a picked file and check that it is a bundle this player understands. */
export async function inspectBundle(file) {
  let zip;
  try {
    zip = await openZip(file);
  } catch (error) {
    if (error instanceof BundleError) {
      throw new BundleError('not-bundle', 'This file is not a game bundle. Pick the .vnbundle.zip file made by the converter.');
    }
    throw error;
  }
  if (!zip.has('manifest.json')) {
    throw new BundleError('not-bundle', 'This zip file is not a game bundle. Pick the .vnbundle.zip file made by the converter.');
  }
  const manifest = await zip.json('manifest.json');
  if (manifest.format !== 1 || !manifest.id || !manifest.start || !manifest.screen) {
    throw new BundleError('not-bundle', 'This bundle was made by a different version of the converter. Convert the game again, then import the new file.');
  }
  return { zip, manifest };
}

function copyToOpfs(file, name, onProgress) {
  return new Promise((resolve, reject) => {
    const unsupported = () => reject(Object.assign(new Error('no private file system'), { name: 'NoOPFS' }));
    if (!navigator.storage || !navigator.storage.getDirectory || typeof Worker === 'undefined') return unsupported();
    let worker;
    try {
      worker = new Worker(new URL('./import-worker.js', import.meta.url));
    } catch (_) {
      return unsupported();
    }
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress({ phase: 'copying', done: message.done, total: message.total });
        return;
      }
      worker.terminate();
      if (message.type === 'done') resolve('opfs');
      else reject(Object.assign(new Error(message.message), { name: message.name }));
    };
    worker.onerror = () => { worker.terminate(); unsupported(); };
    worker.postMessage({ file, name });
  });
}

async function copyToIdb(file, id, onProgress) {
  const CHUNK = 8 * MB;
  for (let at = 0, n = 0; at < file.size; at += CHUNK, n++) {
    const piece = new Blob([await file.slice(at, at + CHUNK).arrayBuffer()]);
    await idb.put('chunks', [id, n], piece);
    onProgress({ phase: 'copying', done: Math.min(at + CHUNK, file.size), total: file.size });
  }
  return 'idb';
}

/**
 * Copy a bundle onto the device. onProgress gets {phase: 'reading' | 'copying' | 'checking', done, total}.
 * Throws StorageFullError when there is not enough room, BundleError when the file is not a bundle.
 */
export async function importBundle(file, { onProgress = () => {}, ignoreEstimate = false } = {}) {
  onProgress({ phase: 'reading' });
  const { zip, manifest } = await inspectBundle(file);
  const id = manifest.id;
  const previous = await idb.get('games', id);

  if (!ignoreEstimate) {
    const info = await storageInfo();
    if (info.quota != null && info.usage != null) {
      const free = info.quota - info.usage + (previous ? previous.size : 0);
      const need = file.size + 16 * MB;          // a little headroom for saves and bookkeeping
      if (free < need) throw new StorageFullError(need, Math.max(free, 0));
    }
  }
  try { if (navigator.storage.persist) await navigator.storage.persist(); } catch (_) { /* optional */ }

  // The old copy goes first so that a re-import does not need room for both.
  await removeData(id);
  await idb.del('games', id);

  let storage;
  try {
    try {
      storage = await copyToOpfs(file, id + '.zip', onProgress);
    } catch (error) {
      if (error.name !== 'NoOPFS') throw error;
      storage = await copyToIdb(file, id, onProgress);
    }
    onProgress({ phase: 'checking' });
    const record = {
      id, title: manifest.title || id, size: file.size, files: zip.entries.size,
      storage, importedAt: Date.now(),
    };
    await idb.put('games', id, record);
    const stored = await openGame(id);
    if (stored.zip.entries.size !== zip.entries.size) throw new BundleError('damaged', 'The copy on this device does not match the file. Please try the import again.');
    return record;
  } catch (error) {
    await removeData(id);
    await idb.del('games', id).catch(() => {});
    if (error && error.name === 'QuotaExceededError') throw new StorageFullError(file.size, null);
    throw error;
  }
}

/**
 * Bring the stored bundle files and the game list back in step at start-up.
 * A file without a record is opened and checked: a complete bundle gets its record
 * back (so a lost list never costs a game), and only a copy that is not a readable
 * bundle (an import that was cut short) is removed.
 */
export async function cleanUp() {
  let dir;
  let known;
  try {
    dir = await bundlesDir(false);
    known = new Set((await idb.all('games')).map((g) => g.id));
  } catch (_) {
    return;                       // no bundles folder yet, or the list cannot be read: touch nothing
  }
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !name.endsWith('.zip')) continue;
    const id = name.slice(0, -4);
    if (known.has(id)) continue;
    try {
      const file = await handle.getFile();
      const { zip, manifest } = await inspectBundle(file);
      if (manifest.id !== id) throw new BundleError('damaged');
      await idb.put('games', id, {
        id, title: manifest.title || id, size: file.size, files: zip.entries.size,
        storage: 'opfs', importedAt: file.lastModified || Date.now(),
      });
      console.warn('restored the record of a stored bundle:', id);
    } catch (error) {
      console.warn('removing an incomplete bundle file:', name, error && error.message);
      await dir.removeEntry(name).catch(() => {});
    }
  }
}

// ---- backup of saves (a small JSON file the user can keep in Files) ----------

const pack = (value) => JSON.stringify(value, (key, v) => (
  v instanceof Uint8Array ? { $u8: btoa(String.fromCharCode.apply(null, v)) } : v
));
const unpack = (text) => JSON.parse(text, (key, v) => (
  v && typeof v === 'object' && typeof v.$u8 === 'string'
    ? Uint8Array.from(atob(v.$u8), (c) => c.charCodeAt(0)) : v
));

export async function exportBackup() {
  return pack({
    app: 'vn-player', version: 1, time: Date.now(),
    saves: await idb.entries('saves'),
    kv: await idb.entries('kv'),
  });
}

export async function importBackup(text) {
  let data;
  try { data = unpack(text); } catch (_) { data = null; }
  if (!data || data.app !== 'vn-player' || !Array.isArray(data.saves)) {
    throw new BundleError('not-backup', 'This file is not a save backup made by this player.');
  }
  for (const [key, value] of data.saves) await idb.put('saves', key, value);
  for (const [key, value] of data.kv || []) await idb.put('kv', key, value);
  return data.saves.length;
}
