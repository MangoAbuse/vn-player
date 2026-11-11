// Draws the scene on a canvas.
//
// Two copies of the picture are kept: `staged` is what the script has set up, `shown`
// is what is on screen. Script commands only change `staged`; a wipe() fades from
// `shown` to `staged`. That matches both original engines.
//
// A state is plain JSON (so it can go straight into a save):
//   bg       {src | color, x, y, blur}            games with one background, overlays and slots
//   layers   {n: {src | color, alpha, x, y}}      overlays, 0 below the sprites, 1-3 above
//   sprites  {slot: src}                          bottom aligned at manifest.slots[slot]
//   L        {layer: {slot: {src | color, x, y, ax, ay, base}}}   games with numbered layers

import { frame } from './util.js';

const SPRITE_ORDER = ['L', 'R', 'CL', 'CR', 'C'];
const TRANSIENT_LAYER = 3;      // an overlay that is shown by one wipe and gone at the next (flashes)
const byNumber = (a, b) => a - b;

export class Stage {
  constructor(game, canvas) {
    this.game = game;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.w = game.manifest.screen.w;
    this.h = game.manifest.screen.h;
    this.slots = game.manifest.slots || {};
    this.k = 1;                               // canvas pixels per screen unit
    this.images = new Map();                  // key -> {image, promise}
    this.bufA = document.createElement('canvas');
    this.bufB = document.createElement('canvas');
    this.anim = null;
    this.shown = this.empty();
    this.staged = this.empty();
    this.resize(1);
  }

  empty() {
    return { bg: null, layers: {}, sprites: {}, L: {} };
  }

  clone(state) {
    return JSON.parse(JSON.stringify(state));
  }

  resize(pixelScale) {
    const k = Math.max(0.5, Math.min(pixelScale, 2, 2048 / this.w));
    const width = Math.round(this.w * k);
    const height = Math.round(this.h * k);
    if (width === this.canvas.width && height === this.canvas.height) return;
    this.hurry();
    this.k = width / this.w;
    for (const c of [this.canvas, this.bufA, this.bufB]) {
      c.width = width;
      c.height = height;
    }
    this.draw(this.shown);
  }

  // ------------------------------------------------------------------ images
  sources(state) {
    const keys = [];
    if (state.bg && state.bg.src) keys.push(state.bg.blur ? state.bg.src + '|blur' : state.bg.src);
    for (const layer of Object.values(state.layers)) if (layer.src) keys.push(layer.src);
    for (const src of Object.values(state.sprites)) if (src) keys.push(src);
    for (const slots of Object.values(state.L)) {
      for (const item of Object.values(slots)) {
        if (item.src) keys.push(item.src);
        if (item.base) keys.push(item.base.src);
      }
    }
    return keys;
  }

  load(key) {
    let entry = this.images.get(key);
    if (entry) {
      this.images.delete(key);            // move to the fresh end of the list
      this.images.set(key, entry);
      return entry.promise;
    }
    entry = { image: null, promise: null };
    entry.promise = this.fetchImage(key).then(
      (image) => { entry.image = image; },
      (error) => { console.warn('image failed', key, error); },
    );
    this.images.set(key, entry);
    return entry.promise;
  }

  async fetchImage(key) {
    const blur = key.endsWith('|blur');
    const blob = await this.game.zip.blob(blur ? key.slice(0, -5) : key);
    let image = null;
    if (typeof createImageBitmap === 'function') {
      try { image = await createImageBitmap(blob); } catch (_) { image = null; }
    }
    if (!image) {
      image = new Image();
      image.src = URL.createObjectURL(blob);
      await image.decode();
    }
    return blur ? softened(image) : image;
  }

  get(key) {
    const entry = this.images.get(key);
    return entry ? entry.image : null;
  }

  async prepare(state) {
    const keys = this.sources(state);
    await Promise.all(keys.map((key) => this.load(key)));
    const keep = new Set([...keys, ...this.sources(this.shown)]);
    for (const [key, entry] of this.images) {
      if (this.images.size <= 40) break;
      if (keep.has(key) || !entry.image) continue;
      this.images.delete(key);
      if (entry.image.close) entry.image.close();
      else if (entry.image.src) URL.revokeObjectURL(entry.image.src);
    }
  }

  // ----------------------------------------------------------------- drawing
  draw(state, ctx = this.ctx) {
    const { w, h, k } = this;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    if (state.bg) this.paint(ctx, state.bg, state.bg.blur);
    if (state.layers[0]) this.paint(ctx, state.layers[0]);
    for (const slot of SPRITE_ORDER) {
      const image = state.sprites[slot] && this.get(state.sprites[slot]);
      if (image) ctx.drawImage(image, Math.round((this.slots[slot] ?? w / 2) - image.width / 2), h - image.height);
    }
    for (const n of [1, 2, 3]) if (state.layers[n]) this.paint(ctx, state.layers[n]);

    for (const layer of Object.keys(state.L).map(Number).sort(byNumber)) {
      const slots = state.L[layer];
      for (const slot of Object.keys(slots).map(Number).sort(byNumber)) this.paintSlot(ctx, slots[slot]);
    }
    ctx.globalAlpha = 1;
  }

  paint(ctx, item, blur) {
    ctx.globalAlpha = item.alpha ?? 1;
    if (item.color) {
      ctx.fillStyle = item.color;
      ctx.fillRect(item.x || 0, item.y || 0, this.w, this.h);
    } else {
      const image = this.get(blur ? item.src + '|blur' : item.src);
      if (image) ctx.drawImage(image, item.x || 0, item.y || 0);
    }
    ctx.globalAlpha = 1;
  }

  paintSlot(ctx, item) {
    if (item.color) {
      ctx.fillStyle = item.color;
      ctx.fillRect(0, 0, this.w, this.h);
      return;
    }
    const x = item.x || 0;
    const y = item.y || 0;
    if (item.base) {
      const body = this.get(item.base.src);
      if (body) ctx.drawImage(body, x - (item.base.ax || 0), y - (item.base.ay || 0));
    }
    const image = this.get(item.src);
    if (image) ctx.drawImage(image, x - (item.ax || 0), y - (item.ay || 0));
  }

  // -------------------------------------------------------------- transitions
  animate(ms, paint) {
    return new Promise((resolve) => {
      const anim = { stop: false };
      this.anim = anim;
      const start = performance.now();
      const step = (now) => {
        const t = anim.stop ? 1 : Math.min(1, (now - start) / ms);
        if (t < 1) {
          paint(t);
          frame(step);
        } else {
          if (this.anim === anim) this.anim = null;
          resolve();
        }
      };
      frame(step);
    });
  }

  /** Finish the running transition now (a tap, a resize, or the game being stopped). */
  hurry() {
    if (this.anim) this.anim.stop = true;
  }

  /** Reveal what the script has staged, fading over ms. */
  async wipe(ms) {
    await this.prepare(this.staged);
    const next = this.clone(this.staged);
    delete this.staged.L[TRANSIENT_LAYER];
    const same = JSON.stringify(next) === JSON.stringify(this.shown);
    if (!(ms > 0) || same) {
      this.shown = next;
      this.draw(next);
      return;
    }
    const a = this.bufA.getContext('2d');
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.globalAlpha = 1;
    a.drawImage(this.canvas, 0, 0);
    this.shown = next;
    this.draw(next, this.bufB.getContext('2d'));
    const ctx = this.ctx;
    await this.animate(ms, (t) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.bufA, 0, 0);
      ctx.globalAlpha = t;
      ctx.drawImage(this.bufB, 0, 0);
      ctx.globalAlpha = 1;
    });
    this.draw(this.shown);
  }

  /** Slide the background or an overlay layer that is already on screen. */
  async move(target, ms, x, y) {
    const pick = (state) => (target === 'bg' ? state.bg : state.layers[Number(target.slice(5))]);
    const shown = pick(this.shown);
    const staged = pick(this.staged);
    const ref = shown || staged;
    if (!ref) return;
    const from = { x: ref.x || 0, y: ref.y || 0 };
    const to = {
      x: x && typeof x === 'object' ? from.x + x.rel : x,
      y: y && typeof y === 'object' ? from.y + y.rel : y,
    };
    if (staged) { staged.x = to.x; staged.y = to.y; }
    if (!shown) return;
    if (ms > 0) {
      await this.animate(ms, (t) => {
        shown.x = from.x + (to.x - from.x) * t;
        shown.y = from.y + (to.y - from.y) * t;
        this.draw(this.shown);
      });
    }
    shown.x = to.x;
    shown.y = to.y;
    this.draw(this.shown);
  }

  // -------------------------------------------------------------- save / load
  snapshot() {
    return this.clone(this.staged);
  }

  async restore(state) {
    this.hurry();
    this.staged = { ...this.empty(), ...this.clone(state || {}) };
    await this.prepare(this.staged);
    this.shown = this.clone(this.staged);
    this.draw(this.shown);
  }

  reset() {
    this.hurry();
    this.staged = this.empty();
    this.shown = this.empty();
    this.draw(this.shown);
  }

  /** Small picture of the current screen for a save slot. */
  thumbnail(width = 240) {
    const small = document.createElement('canvas');
    small.width = width;
    small.height = Math.round(width * this.h / this.w);
    small.getContext('2d').drawImage(this.canvas, 0, 0, small.width, small.height);
    try { return small.toDataURL('image/jpeg', 0.6); } catch (_) { return null; }
  }
}

/** A blurred copy of an image (canvas filters are not available in Safari, so shrink and re-enlarge). */
function softened(image) {
  let current = image;
  let w = image.width;
  let h = image.height;
  for (let i = 0; i < 4; i++) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    small.getContext('2d').drawImage(current, 0, 0, w, h);
    current = small;
  }
  const out = document.createElement('canvas');
  out.width = image.width;
  out.height = image.height;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, 0, 0, out.width, out.height);
  if (image.close) image.close();
  return out;
}
