// Reads a bundle .zip straight out of a Blob. Only the directory is parsed up front;
// file contents are handed out as byte ranges of the Blob (media is stored uncompressed),
// so a 1 GB bundle never has to be held in memory.

export class BundleError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const MIME = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', mp4: 'video/mp4', json: 'application/json',
};

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export async function openZip(blob) {
  if (blob.size < 22) throw new BundleError('not-zip');
  const tailLength = Math.min(blob.size, 65536 + 22 + 20);
  const tail = new DataView(await blob.slice(blob.size - tailLength).arrayBuffer());
  let p = tail.byteLength - 22;
  while (p >= 0 && tail.getUint32(p, true) !== SIG_EOCD) p--;
  if (p < 0) throw new BundleError('not-zip');

  let count = tail.getUint16(p + 10, true);
  let dirSize = tail.getUint32(p + 12, true);
  let dirOffset = tail.getUint32(p + 16, true);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    const lp = p - 20;
    if (lp < 0 || tail.getUint32(lp, true) !== SIG_LOCATOR64) throw new BundleError('damaged');
    const at = Number(tail.getBigUint64(lp + 8, true));
    const rec = new DataView(await blob.slice(at, at + 56).arrayBuffer());
    if (rec.byteLength < 56 || rec.getUint32(0, true) !== SIG_EOCD64) throw new BundleError('damaged');
    count = Number(rec.getBigUint64(32, true));
    dirSize = Number(rec.getBigUint64(40, true));
    dirOffset = Number(rec.getBigUint64(48, true));
  }
  if (dirOffset + dirSize > blob.size) throw new BundleError('damaged');

  const buffer = await blob.slice(dirOffset, dirOffset + dirSize).arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  const entries = new Map();
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > view.byteLength || view.getUint32(at, true) !== SIG_CENTRAL) throw new BundleError('damaged');
    const method = view.getUint16(at + 10, true);
    let csize = view.getUint32(at + 20, true);
    let size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (size === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
      let e = at + 46 + nameLength;
      const end = e + extraLength;
      while (e + 4 <= end) {
        const id = view.getUint16(e, true);
        const length = view.getUint16(e + 2, true);
        if (id === 1) {
          let q = e + 4;
          if (size === 0xffffffff) { size = Number(view.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(view.getBigUint64(q, true)); q += 8; }
          if (offset === 0xffffffff) offset = Number(view.getBigUint64(q, true));
          break;
        }
        e += 4 + length;
      }
    }
    entries.set(name, { offset, csize, size, method, data: -1 });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return new Zip(blob, entries);
}

export class Zip {
  constructor(blob, entries) {
    this.source = blob;
    this.entries = entries;
  }

  has(name) {
    return this.entries.has(name);
  }

  async locate(name) {
    const entry = this.entries.get(name);
    if (!entry) throw new BundleError('missing', `"${name}" is not in the bundle`);
    if (entry.data < 0) {
      const head = new DataView(await this.source.slice(entry.offset, entry.offset + 30).arrayBuffer());
      if (head.byteLength < 30 || head.getUint32(0, true) !== SIG_LOCAL) throw new BundleError('damaged');
      entry.data = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    }
    return entry;
  }

  /** A Blob for one entry. Stored entries are a plain byte range; deflated ones are inflated first. */
  async blob(name) {
    const entry = await this.locate(name);
    const type = MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] || '';
    const raw = this.source.slice(entry.data, entry.data + entry.csize, type);
    if (entry.method === 0) return raw;
    if (entry.method !== 8) throw new BundleError('damaged', `unsupported compression in "${name}"`);
    if (typeof DecompressionStream === 'undefined') {
      throw new BundleError('old-browser', 'This browser is too old to open the bundle (iPadOS 16.4 or later is needed).');
    }
    const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Blob([await new Response(stream).arrayBuffer()], { type });
  }

  async bytes(name) {
    return (await this.blob(name)).arrayBuffer();
  }

  async json(name) {
    return JSON.parse(await (await this.blob(name)).text());
  }
}
