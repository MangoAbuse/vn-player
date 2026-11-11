// Text boxes, typewriter effect and choice buttons. All of it is ordinary DOM laid out
// in the game's own coordinates; the whole stage is scaled with a CSS transform.

import { frame, h } from './util.js';

const FAMILIES = {
  'Tahoma': 'Tahoma, Verdana, "Helvetica Neue", sans-serif',
  'sans-serif': '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

export class TextUI {
  constructor(game, layer, choices, settings) {
    this.game = game;
    this.layer = layer;
    this.choices = choices;
    this.settings = settings;
    this.font = { size: 24, lineHeight: 36, color: '#ffffff', outline: '#000000', ...game.manifest.font };
    this.screen = game.manifest.screen;
    this.boxes = {};
    this.active = null;       // name of the box that holds the current text
    this.typing = null;       // running typewriter job
    this.urls = new Map();    // image path -> blob URL
    this.build();
    this.ready = this.loadBackgrounds();
  }

  build() {
    this.layer.replaceChildren();
    const family = FAMILIES[this.font.family] || `${this.font.family || ''}, ${FAMILIES['sans-serif']}`.replace(/^, /, '');
    this.layer.style.fontFamily = family;
    this.layer.style.color = this.font.color;
    const o = this.font.outline;
    this.layer.style.textShadow = o ? `0 0 2px ${o}, 0 0 2px ${o}, 0 1px 3px ${o}` : 'none';

    for (const [name, def] of Object.entries(this.game.manifest.boxes || {})) {
      const adv = def.style === 'adv';
      const wrap = h('div', { class: 'box ' + (adv ? 'adv' : 'nvl') });
      wrap.hidden = true;
      const box = { name, def, adv, wrap, bg: null, panel: null, text: null, probe: null, who: null, face: null };
      if (def.bg) {
        box.bg = h('img', { class: 'box-bg', alt: '', style: { left: (def.bgx || 0) + 'px', top: (def.bgy || 0) + 'px' } });
        wrap.append(box.bg);
      }
      box.text = h('div', { class: 'box-text' });
      box.probe = h('div', { class: 'box-text box-probe' });
      box.panel = h('div', { class: 'box-panel' }, box.probe, box.text);
      box.panel.style.left = def.x + 'px';
      box.panel.style.width = def.w + 'px';
      if (adv) {
        box.panel.style.bottom = (this.screen.h - def.y - def.h) + 'px';
        box.panel.style.minHeight = def.h + 'px';
        box.who = h('div', { class: 'adv-name' });
        box.who.hidden = true;
        box.face = h('img', { class: 'adv-face', alt: '' });
        box.face.hidden = true;
        box.panel.append(box.who, box.face);
      } else {
        box.panel.style.top = def.y + 'px';
        box.panel.style.height = def.h + 'px';
      }
      wrap.append(box.panel);
      this.layer.append(wrap);
      this.boxes[name] = box;
    }
  }

  async url(path) {
    let url = this.urls.get(path);
    if (!url) {
      url = URL.createObjectURL(await this.game.zip.blob(path));
      this.urls.set(path, url);
    }
    return url;
  }

  async loadBackgrounds() {
    for (const box of Object.values(this.boxes)) {
      if (box.bg) {
        try { box.bg.src = await this.url(box.def.bg); } catch (error) { console.warn('box image failed', error); }
      }
    }
  }

  dispose() {
    this.finish();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.layer.replaceChildren();
    this.choices.replaceChildren();
    this.choices.hidden = true;
  }

  // ------------------------------------------------------------------- boxes
  showBox(name) {
    const box = this.boxes[name];
    if (box) box.wrap.hidden = false;
  }

  hideBox(name) {
    const box = this.boxes[name];
    if (!box) return;
    this.finish();
    box.wrap.hidden = true;
    box.text.replaceChildren();
    if (this.active === name) this.active = null;
  }

  hideAll() {
    for (const name of Object.keys(this.boxes)) this.hideBox(name);
  }

  clearText(name = this.active) {
    const box = this.boxes[name];
    if (!box) return;
    this.finish();
    box.text.replaceChildren();
  }

  /**
   * Start a page (or, with keep, carry on the one that is showing).
   * fit is all the text the page will hold, so the font can be sized before typing starts.
   */
  begin(name, { who = null, face = null, keep = false, fit = '' } = {}) {
    const box = this.boxes[name];
    if (!box) return;
    this.finish();
    for (const other of Object.values(this.boxes)) {
      if (other !== box && other.adv === box.adv && !other.wrap.hidden && other.text.childNodes.length) {
        other.text.replaceChildren();
      }
    }
    box.wrap.hidden = false;
    this.active = name;
    if (!keep) box.text.replaceChildren();
    if (box.adv) {
      box.who.hidden = !who;
      box.who.textContent = who || '';
      box.face.hidden = true;
      if (face) {
        this.url(face).then((url) => {
          if (this.active === name) { box.face.src = url; box.face.hidden = false; }
        }).catch(() => {});
      }
    }
    if (box.adv) this.fit(box, fit);
    else if (!keep) this.fit(box, '');
  }

  /** Pick a font size at which `text` fits the box (the normal size, or smaller for a long line). */
  fit(box, text) {
    const scale = this.settings.fontScale || 1;
    const ratio = this.font.lineHeight / this.font.size;
    let size = this.font.size * scale;
    const limit = box.adv ? box.def.h - 36 : box.def.h;
    box.probe.textContent = text;
    for (let i = 0; i < 9; i++) {
      box.probe.style.fontSize = size + 'px';
      box.probe.style.lineHeight = (size * ratio) + 'px';
      if (!text || box.probe.scrollHeight <= limit + 1) break;
      size *= 0.94;
    }
    box.probe.textContent = '';
    box.text.style.fontSize = size + 'px';
    box.text.style.lineHeight = (size * ratio) + 'px';
  }

  /**
   * Page-style boxes: called before the next stretch of text is typed. If it does not
   * fit under what is already on the page, the page is cleared first, as the original does.
   */
  makeRoom(text) {
    const box = this.boxes[this.active];
    if (!box || box.adv || !text) return;
    this.finish();
    const current = box.text.textContent;
    if (current) {
      box.probe.style.fontSize = box.text.style.fontSize;
      box.probe.style.lineHeight = box.text.style.lineHeight;
      box.probe.textContent = current + text;
      const fits = box.probe.scrollHeight <= box.def.h + 1;
      box.probe.textContent = '';
      if (fits) return;
      box.text.replaceChildren();
    }
    this.fit(box, text.replace(/^\s+/, ''));
  }

  // -------------------------------------------------------------- typewriter
  /** Add text to the current page. Resolves when it is fully shown. */
  type(text, instant) {
    const box = this.boxes[this.active];
    if (!box || !text) return Promise.resolve();
    this.finish();
    if (!box.text.firstChild) text = text.replace(/^\s+/, '');      // no blank line at the top of a page
    if (!text) return Promise.resolve();
    const speed = this.settings.textSpeed;
    if (instant || !speed || speed >= 125) {
      box.text.append(text);
      return Promise.resolve();
    }
    const shown = document.createTextNode('');
    const rest = h('span', { class: 'pending', text });
    box.text.append(shown, rest);
    return new Promise((resolve) => {
      const start = performance.now();
      const job = {
        over: false,
        finish: () => {
          if (job.over) return;
          job.over = true;
          shown.data = text;
          rest.remove();
          if (this.typing === job) this.typing = null;
          resolve();
        },
      };
      this.typing = job;
      const step = (now) => {
        if (job.over) return;
        const count = Math.floor((now - start) / 1000 * speed) + 1;
        if (count >= text.length) { job.finish(); return; }
        shown.data = text.slice(0, count);
        rest.textContent = text.slice(count);
        frame(step);
      };
      step(start);
    });
  }

  /** Show the rest of the text that is being typed, now. */
  finish() {
    if (this.typing) this.typing.finish();
  }

  /** The text on screen, for save-slot labels. */
  plain() {
    const box = this.boxes[this.active];
    return box ? box.text.textContent : '';
  }

  // ----------------------------------------------------------------- choices
  choose(options) {
    return new Promise((resolve) => {
      this.choices.replaceChildren();
      this.choices.classList.add('arming');
      options.forEach((label, index) => {
        this.choices.append(h('button', {
          class: 'choice', type: 'button', text: label,
          onclick: (event) => {
            event.stopPropagation();
            this.choices.hidden = true;
            this.choices.replaceChildren();
            resolve(index);
          },
        }));
      });
      this.choices.hidden = false;
      // A moment before the buttons react, so the tap that advanced the text cannot pick one.
      setTimeout(() => this.choices.classList.remove('arming'), 300);
    });
  }

  cancelChoice() {
    this.choices.hidden = true;
    this.choices.replaceChildren();
  }

  // -------------------------------------------------------------- save / load
  snapshot() {
    return Object.values(this.boxes).filter((b) => !b.wrap.hidden).map((b) => b.name);
  }

  restore(shown) {
    this.hideAll();
    for (const name of shown || []) this.showBox(name);
  }
}
