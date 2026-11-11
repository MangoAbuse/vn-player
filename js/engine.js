// Runs the script ops of a bundle (see converter/bundle.py for the op list).
//
// The engine is one async loop. Ops that take time (text, waits, fades, choices)
// return a promise; everything else runs straight through. A snapshot of the whole
// game state is taken whenever a text line or a choice starts; saving stores that
// snapshot, loading restores it and runs the same op again.

import { kv } from './store.js';

export class Cancelled extends Error {}

/** Give the browser a turn (a real task, not a microtask; unlike setTimeout it is not slowed in the background). */
const breathe = (() => {
  const channel = new MessageChannel();
  const waiting = [];
  channel.port1.onmessage = () => { const next = waiting.shift(); if (next) next(); };
  return () => new Promise((resolve) => { waiting.push(resolve); channel.port2.postMessage(0); });
})();

/** Lines the original shows in one box: does a space belong between them? */
function needsSpace(before, after) {
  return !!before && !/[\s―—-]$/.test(before) && !/^[\s.,!?…”’)\]:;]/.test(after);
}

/** Arithmetic in the original script syntax, used by $v(...) inside text: #6001, #6451[#6139]+1 */
function evalRaw(source, getVar) {
  const src = source.replace(/\s+/g, '');
  let i = 0;
  const number = () => {
    const start = i;
    while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
    return Number(src.slice(start, i)) || 0;
  };
  const primary = () => {
    if (src[i] === '#') {
      i++;
      const n = number();
      let index = 0;
      if (src[i] === '[') { i++; index = sum(); i++; }
      return getVar(n + index);
    }
    if (src[i] === '(') { i++; const v = sum(); i++; return v; }
    if (src[i] === '-') { i++; return -primary(); }
    return number();
  };
  const product = () => {
    let v = primary();
    while (src[i] === '*' || src[i] === '/' || src[i] === '%') {
      const op = src[i++];
      const r = primary();
      v = op === '*' ? v * r : !r ? 0 : op === '/' ? Math.trunc(v / r) : v % r;
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (src[i] === '+' || src[i] === '-') {
      const op = src[i++];
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  return sum();
}

export class Engine {
  constructor({ game, stage, text, audio, ui, settings }) {
    this.game = game;
    this.stage = stage;
    this.text = text;
    this.audio = audio;
    this.ui = ui;
    this.settings = settings;
    this.manifest = game.manifest;
    const vars = this.manifest.vars || {};
    this.argBase = vars.argBase ?? 0;
    [this.localLo, this.localHi] = vars.locals || [1, 0];
    this.globalRanges = vars.globals || [];
    this.names = this.manifest.names || {};
    const minigames = this.manifest.minigames || {};
    this.rushNames = new Set(minigames.rush || []);
    this.resolvers = minigames.resolve || [];
    this.rushMark = -1;            // value of `progress` when a minigame command last ran

    this.scenes = new Map();       // scene id -> ops (a few recent ones)
    this.globals = {};             // survive "New game" and loading
    this.read = {};                // scene id -> bitset of text ops already read
    this.dirty = { globals: false, read: false };

    this.progress = 0;             // bumped whenever the script reaches something the user answers
    this.epoch = 0;                // bumped to stop the running loop
    this.running = null;
    this.cancelled = false;
    this.waiter = null;            // what a tap should resolve right now
    this.auto = false;
    this.skip = false;             // the user asked to skip
    this.skipping = false;         // ... and the current line may be skipped
    this.fast = false;             // rebuilding state after a load: no time passes
    this.paused = false;           // a menu is open
    this.reset();
  }

  reset() {
    this.scene = null;
    this.ops = [];
    this.pc = 0;
    this.stack = [];
    this.vars = {};
    this.locals = {};
    this.strs = {};
    this.held = null;              // adv line that stays up and takes the next line: {who, text, face}
    this.disp = null;              // adv line on screen: {box, who, text, face}
    this.snap = null;
    this.snapItem = 0;
    this.resumeItem = 0;
  }

  /** No time should pass: skipping, rebuilding after a load, or inside a minigame nobody can see. */
  get quick() {
    return this.fast || this.skipping || this.rushMark === this.progress;
  }

  async init() {
    this.globals = await kv.get('globals:' + this.game.id, {});
    this.read = await kv.get('read:' + this.game.id, {});
  }

  /** Write global variables and the read-text record if they changed. */
  async flush() {
    try {
      if (this.dirty.globals) { this.dirty.globals = false; await kv.set('globals:' + this.game.id, this.globals); }
      if (this.dirty.read) { this.dirty.read = false; await kv.set('read:' + this.game.id, this.read); }
    } catch (error) {
      console.warn('could not store progress', error);
    }
  }

  // ---------------------------------------------------------------- variables
  isGlobal(n) {
    for (const [lo, hi] of this.globalRanges) if (n >= lo && n <= hi) return true;
    return false;
  }

  getVar(key) {
    if (typeof key === 'number') {
      if (key >= this.localLo && key <= this.localHi) return this.locals[key] ?? 0;
      if (this.isGlobal(key)) return this.globals[key] ?? 0;
      return this.vars[key] ?? 0;
    }
    return (key[0] === '#' ? this.globals : this.vars)[key] ?? 0;
  }

  setVar(key, value) {
    if (typeof key === 'number') {
      if (key >= this.localLo && key <= this.localHi) { this.locals[key] = value; return; }
      if (!this.isGlobal(key)) { this.vars[key] = value; return; }
    } else if (key[0] !== '#') {
      this.vars[key] = value;
      return;
    }
    if (this.globals[key] !== value) {
      this.globals[key] = value;
      this.dirty.globals = true;
    }
  }

  /** A variable reference in an op: a name, a number, or ["at", n, expr] for variable n + expr. */
  ref(target) {
    return Array.isArray(target) ? target[1] + this.ev(target[2]) : target;
  }

  ev(e) {
    if (!Array.isArray(e)) return e;
    switch (e[0]) {
      case 'var': return this.getVar(e[1]);
      case 'at': return this.getVar(e[1] + this.ev(e[2]));
      case '!': return this.ev(e[1]) ? 0 : 1;
      case 'neg': return -this.ev(e[1]);
      case '&&': { for (let i = 1; i < e.length; i++) if (!this.ev(e[i])) return 0; return 1; }
      case '||': { for (let i = 1; i < e.length; i++) if (this.ev(e[i])) return 1; return 0; }
      default:
    }
    const a = this.ev(e[1]);
    const b = this.ev(e[2]);
    switch (e[0]) {
      case '==': return a == b ? 1 : 0;       // loose on purpose: true == 1
      case '!=': return a != b ? 1 : 0;
      case '<': return a < b ? 1 : 0;
      case '>': return a > b ? 1 : 0;
      case '<=': return a <= b ? 1 : 0;
      case '>=': return a >= b ? 1 : 0;
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b ? Math.trunc(a / b) : 0;
      case '%': return b ? a % b : 0;
      case '&': return a & b;
      case '|': return a | b;
      default: return 0;
    }
  }

  /** Fill $(slot,lang) and $v(expression) placeholders in a line. */
  subst(text) {
    if (!text || text.indexOf('$') < 0) return text;
    return text
      .replace(/\$\((\d+),\s*\d+\)/g, (all, slot) => this.strs[slot] ?? '')
      .replace(/\$v\(([^()]*)\)/g, (all, source) => String(evalRaw(source, (n) => this.getVar(n))));
  }

  // ----------------------------------------------------------- read-text record
  isRead(pc) {
    const bits = this.read[this.scene];
    return !!(bits && bits[pc >> 3] & (1 << (pc & 7)));
  }

  markRead(pc) {
    let bits = this.read[this.scene];
    const need = (this.ops.length >> 3) + 1;
    if (!bits || bits.length < need) {
      const grown = new Uint8Array(need);
      if (bits) grown.set(bits);
      bits = this.read[this.scene] = grown;
    }
    if (!(bits[pc >> 3] & (1 << (pc & 7)))) {
      bits[pc >> 3] |= 1 << (pc & 7);
      this.dirty.read = true;
    }
  }

  // ------------------------------------------------------------- running loop
  async loadScene(id) {
    let ops = this.scenes.get(id);
    if (ops) {
      this.scenes.delete(id);
    } else {
      const path = `script/${id}.json`;
      if (!this.game.zip.has(path)) throw new Error(`The story jumps to "${id}", which is not in the bundle.`);
      ops = (await this.game.zip.json(path)).ops;
    }
    this.scenes.set(id, ops);
    if (this.scenes.size > 16) this.scenes.delete(this.scenes.keys().next().value);
    return ops;
  }

  async enter(id, to = 0) {
    this.ops = await this.loadScene(String(id));
    this.scene = String(id);
    this.pc = to;
  }

  start() {
    this.cancelled = false;
    this.running = this.loop(++this.epoch);
  }

  async stop() {
    this.epoch++;
    this.cancelled = true;
    this.auto = false;
    this.skip = false;
    this.skipping = false;
    this.ui.modes();
    if (this.waiter) this.waiter.cancel();
    this.stage.hurry();
    this.text.finish();
    this.text.cancelChoice();
    this.ui.cancelBlocking();
    if (this.running) await this.running;
    this.running = null;
  }

  check() {
    if (this.cancelled) throw new Cancelled();
  }

  async loop(epoch) {
    // `progress` moves whenever the script reaches something the user answers (a line to
    // read, a choice, a movie). `streak` counts ops run since then: every 2000 the loop
    // hands control back to the browser, and a very long streak means the script is
    // spinning on a minigame this player does not run.
    let streak = 0;
    let mark = this.progress;
    try {
      while (epoch === this.epoch) {
        if (this.pc >= this.ops.length) {
          await this.op_end();
        } else {
          const op = this.ops[this.pc++];
          const handler = this['op_' + op.op];
          const result = handler ? handler.call(this, op) : undefined;
          if (result && typeof result.then === 'function') await result;
        }
        if (this.progress !== mark) {
          mark = this.progress;
          streak = 0;
        } else if (++streak % 2000 === 0) {
          await breathe();
          if (streak >= 300000) {
            streak = 0;
            await this.escapeLoop();
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Cancelled)) {
        console.error(error);
        this.ui.fatal(error);
      }
    }
  }

  /** The script is spinning without showing anything: it is waiting on a minigame this player skips. */
  async escapeLoop() {
    console.warn('script loop with no output', this.scene, this.pc);
    this.ui.toast('Skipped a part this player cannot run (a minigame).');
    if (this.stack.some((f) => f.k === 'call')) await this.op_ret();
    else this.finish();
  }

  async newGame() {
    await this.stop();
    this.reset();
    this.audio.stopAll(200);
    this.text.hideAll();
    this.stage.reset();
    await this.enter(this.manifest.start);
    this.start();
  }

  finish() {
    this.epoch++;
    this.flush();
    this.ui.ended();
  }

  // ------------------------------------------------------------------ waiting
  /** Wait for a tap. In auto mode it also ends by itself (after the voice clip, if any). */
  waitTap({ voice = null, autoMs = 900 } = {}) {
    this.check();
    this.progress++;
    return new Promise((resolve, reject) => {
      let over = false;
      let timer = 0;
      const waiter = {
        tap: () => finish(),
        cancel: () => finish(new Cancelled()),
        kick: () => arm(),
      };
      const finish = (error) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        if (this.waiter === waiter) this.waiter = null;
        if (error) reject(error); else resolve();
      };
      const arm = () => {
        clearTimeout(timer);
        if (over || this.paused) return;
        if (this.skipping) { timer = setTimeout(finish, 30); return; }
        if (!this.auto) return;
        const go = () => {
          if (over || !this.auto || this.paused) return;
          clearTimeout(timer);
          timer = setTimeout(() => { if (this.auto && !this.paused) finish(); }, autoMs);
        };
        if (voice) voice.then(go); else go();
      };
      this.waiter = waiter;
      arm();
    });
  }

  /** Let time pass. A tap ends it early when skippable. Returns nothing (no wait) while skipping. */
  sleep(ms, skippable = true) {
    if (!(ms > 0) || this.quick) return undefined;
    this.check();
    return new Promise((resolve, reject) => {
      let over = false;
      const waiter = {
        tap: () => { if (skippable) finish(); },
        cancel: () => finish(new Cancelled()),
        kick: () => { if (this.skipping) finish(); },
      };
      const finish = (error) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        if (this.waiter === waiter) this.waiter = null;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(finish, ms);
      this.waiter = waiter;
    });
  }

  /** The user tapped the picture. */
  tap() {
    if (this.skip) { this.setSkip(false); return; }
    if (this.text.typing) { this.text.finish(); return; }
    if (this.waiter) this.waiter.tap();
    else this.stage.hurry();
  }

  setAuto(on) {
    this.auto = on;
    if (on) { this.skip = false; this.skipping = false; }
    this.ui.modes();
    if (this.waiter) this.waiter.kick();
  }

  setSkip(on) {
    this.skip = on;
    this.skipping = on;          // the line on screen has been seen; later lines are checked as they start
    if (on) { this.auto = false; this.text.finish(); this.stage.hurry(); }
    this.ui.modes();
    if (this.waiter) this.waiter.kick();
  }

  setPaused(on) {
    this.paused = on;
    if (on && this.skip) this.setSkip(false);
    if (!on && this.waiter) this.waiter.kick();
  }

  // -------------------------------------------------------------- save / load
  takeSnap(pc) {
    this.snapItem = 0;
    this.snap = {
      scene: this.scene,
      pc,
      stack: this.stack.map((f) => (f.locals ? { ...f, locals: { ...f.locals } } : { ...f })),
      vars: { ...this.vars },
      locals: { ...this.locals },
      strs: { ...this.strs },
      held: this.held && { ...this.held },
      disp: this.disp && { ...this.disp },
      screen: this.stage.snapshot(),
      audio: this.audio.snapshot(),
      boxes: this.text.snapshot(),
    };
    this.ui.snapped();
  }

  /** What a save slot stores, or null before the first line. */
  saveState() {
    if (!this.snap) return null;
    return JSON.parse(JSON.stringify({ ...this.snap, item: this.snapItem }));
  }

  async load(state) {
    await this.stop();
    this.reset();
    // The loaded state is also the current snapshot, so saving again right away works.
    const { item = 0, ...snap } = JSON.parse(JSON.stringify(state));
    this.snap = snap;
    this.snapItem = item;
    this.stack = state.stack || [];
    this.vars = state.vars || {};
    this.locals = state.locals || {};
    this.strs = state.strs || {};
    this.held = state.held || null;
    this.disp = state.disp || null;
    this.text.restore(state.boxes);
    await this.stage.restore(state.screen);
    this.audio.restore(state.audio);
    if (this.disp) {
      this.text.begin(this.disp.box, { who: this.disp.who, face: this.disp.face, fit: this.disp.text });
      this.text.type(this.disp.text, true);
    }
    await this.enter(state.scene, state.pc);
    this.resumeItem = state.item || 0;
    this.start();
  }

  // ===================================================================== ops
  // ---- flow
  op_set(op) { this.setVar(this.ref(op.var), this.ev(op.val)); }

  op_rand(op) {
    const lo = this.ev(op.lo);
    const hi = Math.max(lo, this.ev(op.hi));
    this.setVar(this.ref(op.var), lo + Math.floor(Math.random() * (hi - lo + 1)));
  }

  op_fill(op) { for (let n = op.from; n <= op.to; n++) this.setVar(n, op.val); }
  op_setstr(op) { this.strs[op.slot] = op.text; }
  op_jz(op) { if (!this.ev(op.cond)) this.pc = op.to; }
  op_jnz(op) { if (this.ev(op.cond)) this.pc = op.to; }
  op_jmp(op) { this.pc = op.to; }

  op_switch(op) {
    const index = this.ev(op.on);
    if (Number.isInteger(index) && index >= 0 && index < op.targets.length) this.pc = op.targets[index];
  }

  op_gosub(op) {
    this.stack.push({ k: 'sub', pc: this.pc });
    this.pc = op.to;
  }

  op_return() {
    const top = this.stack[this.stack.length - 1];
    if (top && top.k === 'sub') this.pc = this.stack.pop().pc;
  }

  async op_goto(op) {
    const id = this.ev(op.scene);
    if (!id) { this.finish(); return; }
    await this.enter(id, op.to || 0);
  }

  async op_call(op) {
    const args = (op.args || []).map((a) => this.ev(a));      // read them before the locals change hands
    this.stack.push({ k: 'call', scene: this.scene, pc: this.pc, locals: this.locals });
    this.locals = {};
    args.forEach((value, i) => { this.locals[this.argBase + i] = value; });
    await this.enter(op.scene, op.to || 0);
  }

  async op_ret() {
    let frame = this.stack.pop();
    while (frame && frame.k !== 'call') frame = this.stack.pop();
    if (!frame) { this.finish(); return; }
    this.locals = frame.locals || {};
    await this.enter(frame.scene, frame.pc);
  }

  /** End of a scene: go back to the caller, or the story is over. */
  async op_end() {
    if (this.stack.some((f) => f.k === 'call')) await this.op_ret();
    else this.finish();
  }

  /** A command of the original engine the player does not run (minigames, trophies, extra effects). */
  op_ext(op) {
    if (op.name === 'DEL_CALLSTACK') { this.stack = []; return; }
    if (this.rushNames.has(op.name)) this.rushMark = this.progress;     // until the next line of text
    for (const rule of this.resolvers) {
      if (rule.name !== op.name || !rule.codes.includes((op.w || [])[0])) continue;
      if (rule.zeroOneOf.some((v) => this.getVar(v) <= 0)) continue;       // already decided
      const pick = rule.zeroOneOf[Math.floor(Math.random() * rule.zeroOneOf.length)];
      this.setVar(pick, 0);
    }
  }

  // ---- screen
  op_clear() {
    this.stage.staged = this.stage.empty();
    this.text.hideAll();
    this.held = null;
    this.disp = null;
  }

  op_bg(op) {
    let src = op.src;
    for (const alt of op.alt || []) {
      if (this.ev(alt.if)) { src = alt.src; break; }
    }
    const staged = this.stage.staged;
    if (src) staged.bg = { src, x: 0, y: 0, blur: op.blurIf ? !!this.ev(op.blurIf) : false };
    else if (op.color) staged.bg = { color: op.color };
    else staged.bg = null;
  }

  op_layer(op) {
    const layers = this.stage.staged.layers;
    if (op.src) layers[op.n] = { src: op.src, alpha: op.alpha ?? 1, x: op.x || 0, y: op.y || 0 };
    else if (op.color) layers[op.n] = { color: op.color, alpha: op.alpha ?? 1, x: 0, y: 0 };
    else delete layers[op.n];
  }

  op_sprite(op) {
    if (op.src) this.stage.staged.sprites[op.slot] = op.src;
    else delete this.stage.staged.sprites[op.slot];
  }

  op_init(op) { delete this.stage.staged.L[op.layer]; }

  op_img(op) {
    const item = {};
    for (const key of ['src', 'color', 'x', 'y', 'ax', 'ay', 'base']) {
      if (op[key] !== undefined) item[key] = op[key];
    }
    (this.stage.staged.L[op.layer] ||= {})[op.slot] = item;
  }

  op_endscene() { this.stage.staged = this.stage.empty(); }
  op_wipe(op) { return this.stage.wipe(this.quick ? 0 : op.ms); }

  op_move(op) {
    const done = this.stage.move(op.target, this.quick ? 0 : op.ms, op.x, op.y);
    return op.wait ? done : undefined;
  }

  op_flash(op) { return this.quick ? undefined : this.ui.flash(op.color, op.count || 1); }
  op_shake(op) { if (!this.quick) this.ui.shake(op.style); }

  op_box(op) {
    if (op.show) { this.text.showBox(op.box); return; }
    this.text.hideBox(op.box);
    this.held = null;
    this.disp = null;
  }

  op_textclear() {
    this.text.clearText();
    this.held = null;
    this.disp = null;
  }

  async op_roll(op) {
    if (this.fast) return;
    this.progress++;
    await this.ui.roll(op.src, op.ms, !!this.ev(op.skipIf));
    this.check();
  }

  async op_video(op) {
    if (this.fast) return;
    this.progress++;
    await this.ui.video(op.src);
    this.check();
  }

  // ---- timing
  op_wait(op) {
    if (op.ms == null) return this.quick ? undefined : this.waitTap({ autoMs: 700 });
    return this.sleep(op.ms, op.skip !== false);
  }

  // ---- sound
  op_bgm(op) { this.audio.bgm(op.id, this.quick ? 0 : op.ms, op.vol, op.loop); }
  op_bgmloop(op) { this.audio.bgmLoop(op.id, op.on); }

  op_se(op) {
    if (!op.loop && this.quick) return;         // one-shot sounds are dropped while skipping
    this.audio.se(op.ch, op.src, { ms: this.quick ? 0 : op.ms, vol: op.vol, loop: op.loop, voice: op.voice });
  }

  op_sevol(op) { this.audio.seVol(op.ch, this.quick ? 0 : op.ms, op.vol); }
  op_voicestop() { this.audio.stopVoice(); }

  // ---- text
  op_log(op) {
    if (op.text) this.ui.log({ who: this.names[op.who] || op.who || null, text: op.text, voice: op.v || null });
  }

  logLine(op, entry) {
    const text = entry.text.trim();
    if (op.log === false || !text) return;
    this.ui.log({ who: entry.who, text, voice: entry.voice });
  }

  async op_text(op) {
    const pc = this.pc - 1;
    const resume = this.resumeItem;
    this.resumeItem = 0;
    this.rushMark = -1;
    if (resume) this.snapItem = resume; else this.takeSnap(pc);
    if (this.skip) {
      if (this.settings.skipUnread || this.isRead(pc)) this.skipping = true;
      else this.setSkip(false);                 // unread text: stop skipping here
    }

    const box = op.box;
    const adv = (this.manifest.boxes[box] || {}).style === 'adv';
    const items = op.items || [];
    const texts = items.map((item) => (item.t == null ? '' : op.dyn ? this.subst(item.t) : item.t));
    const body = texts.join('');
    let who = null;
    let face = op.face || null;
    let shown = '';                // everything in the box, for saves and joins
    const joined = adv && !!this.held && !op.who;
    if (joined) {
      who = this.held.who;
      face = face || this.held.face || null;
      shown = this.held.text;
      this.text.begin(box, { who, face, keep: true, fit: shown + ' ' + body });
    } else if (adv) {
      who = op.who ? this.subst(op.who) : null;
      this.audio.stopLineVoice();
      this.text.begin(box, { who, face, fit: body });
    } else {
      this.text.begin(box);
    }
    // Page-style boxes start a fresh page when the next stretch of text (up to the next tap) will not fit.
    const makeRoom = (from) => {
      if (adv) return;
      let stretch = '';
      for (let j = from; j < items.length && !items[j].k; j++) stretch += texts[j];
      this.text.makeRoom(stretch);
    };
    makeRoom(0);

    let entry = { who, text: '', voice: null };
    let voiceDone = null;
    let first = true;
    let stretch = 0;               // letters typed since the last tap
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const past = i < resume;                  // part of the page that was already read before a load
      if (item.t != null) {
        let t = texts[i];
        if (first && joined && needsSpace(shown, t)) t = ' ' + t;
        first = false;
        shown += t;
        entry.text += t;
        stretch += t.length;
        await this.text.type(t, past || this.quick);
        this.check();
      } else if (item.v) {
        entry.voice = item.v;
        if (item.who) entry.who = this.names[item.who] || item.who;
        if (!past && !this.quick) voiceDone = this.audio.voice(item.v);
      } else if (item.k) {
        this.logLine(op, entry);
        entry = { who, text: '', voice: null };
        if (!past) {
          if (adv) this.disp = { box, who, text: shown, face };
          // Auto mode: after a voiced line just the pause; after narration, reading time as well.
          const reading = voiceDone ? 0 : Math.min(stretch, 500) * 28;
          await this.waitTap({ voice: voiceDone, autoMs: this.settings.autoDelay + reading });
          voiceDone = null;
          this.snapItem = i + 1;
        }
        stretch = 0;
        makeRoom(i + 1);
      } else if (item.do) {
        const was = this.fast;
        if (past) this.fast = true;
        try {
          const handler = this['op_' + item.do.op];
          const result = handler ? handler.call(this, item.do) : undefined;
          if (result && typeof result.then === 'function') await result;
        } finally {
          this.fast = was;
        }
        this.check();
      }
    }
    this.logLine(op, entry);
    this.markRead(pc);
    this.snapItem = items.length;

    if (adv) {
      this.disp = { box, who, text: shown, face };
      this.held = op.hold ? { who, text: shown, face } : null;
    } else if (op.keep === 0) {
      this.text.hideBox(box);
    } else if (op.keep !== 2) {
      this.text.clearText(box);
    }
  }

  async op_choice(op) {
    this.takeSnap(this.pc - 1);
    if (this.skip) this.setSkip(false);
    const options = (op.options || []).map((o) => this.subst(o));
    if (!options.length) return;
    this.check();
    this.progress++;
    const picked = await new Promise((resolve, reject) => {
      const waiter = {
        tap: () => {},
        kick: () => {},
        cancel: () => { if (this.waiter === waiter) this.waiter = null; reject(new Cancelled()); },
      };
      this.waiter = waiter;
      this.text.choose(options).then((index) => {
        if (this.waiter === waiter) this.waiter = null;
        resolve(index);
      });
    });
    this.setVar(this.ref(op.var), picked + (op.base ?? 1));
    this.ui.log({ who: null, text: '› ' + options[picked], voice: null });
  }
}
