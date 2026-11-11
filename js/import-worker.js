// Copies a picked bundle file into the browser's private file system (OPFS).
// Runs in a worker because Safari only allows writing OPFS files through a
// synchronous access handle, and those only exist in workers.

self.onmessage = async (event) => {
  const { file, name } = event.data;
  let access = null;
  try {
    if (!self.navigator.storage || !self.navigator.storage.getDirectory) {
      throw Object.assign(new Error('no private file system'), { name: 'NoOPFS' });
    }
    const root = await self.navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('bundles', { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    if (!handle.createSyncAccessHandle) {
      throw Object.assign(new Error('no sync access handle'), { name: 'NoOPFS' });
    }
    access = await handle.createSyncAccessHandle();
    access.truncate(0);
    const CHUNK = 8 * 1024 * 1024;
    let done = 0;
    while (done < file.size) {
      const chunk = new Uint8Array(await file.slice(done, done + CHUNK).arrayBuffer());
      let written = 0;
      while (written < chunk.length) {
        const n = access.write(chunk.subarray(written), { at: done + written });
        if (!n) throw Object.assign(new Error('short write'), { name: 'QuotaExceededError' });
        written += n;
      }
      done += chunk.length;
      self.postMessage({ type: 'progress', done, total: file.size });
    }
    access.flush();
    access.close();
    access = null;
    self.postMessage({ type: 'done' });
  } catch (error) {
    try { if (access) access.close(); } catch (_) { /* already closed */ }
    self.postMessage({ type: 'error', name: error && error.name, message: String(error && error.message || error) });
  }
};
