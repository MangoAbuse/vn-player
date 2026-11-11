// Sound through Web Audio. Everything is decoded into buffers and played through gain
// nodes, because on iPad an <audio> element's volume cannot be changed from script
// (so no fades and no volume sliders) and it cannot loop a marked section cleanly.

const LINE = 'line';      // channel used for the voice clip of the current text line

export class AudioEngine {
  constructor(game, volumes) {
    this.game = game;
    this.volumes = { bgm: 0.6, se: 0.8, voice: 1, ...volumes };
    this.ctx = null;
    this.groups = null;
    this.cache = new Map();        // path -> Promise<AudioBuffer>, small LRU
    this.music = new Map();        // same, for music (large buffers, keep two)
    this.channels = new Map();     // channel -> playing sound
    this.current = null;           // playing music {id, source, gain, vol}
    this.bgmToken = 0;
    this.bgmState = null;          // what a save needs: {id, vol, loop}
    this.marks = {};               // track id -> loop the marked section
  }

  /** Must be called from a tap: iPad only lets sound start from a user gesture. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      const master = this.ctx.createGain();
      master.connect(this.ctx.destination);
      this.groups = {};
      for (const name of ['bgm', 'se', 'voice']) {
        const gain = this.ctx.createGain();
        gain.gain.value = this.volumes[name];
        gain.connect(master);
        this.groups[name] = gain;
      }
      // Keep playing with the iPad's silent mode on, like a game or video would.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* optional */ }
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  setVolume(name, value) {
    this.volumes[name] = value;
    if (this.groups) this.groups[name].gain.value = value;
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  // ------------------------------------------------------------------ loading
  decode(data) {
    return new Promise((resolve, reject) => {
      const result = this.ctx.decodeAudioData(data, resolve, reject);   // callback form for older Safari
      if (result && result.catch) result.catch(reject);
    });
  }

  buffer(path, store = this.cache, limit = 24) {
    let entry = store.get(path);
    if (entry) {
      store.delete(path);
      store.set(path, entry);
      return entry;
    }
    entry = this.game.zip.bytes(path).then((data) => this.decode(data));
    entry.catch(() => store.delete(path));
    store.set(path, entry);
    while (store.size > limit) store.delete(store.keys().next().value);
    return entry;
  }

  ramp(param, to, ms) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    if (ms > 0) param.linearRampToValueAtTime(to, now + ms / 1000);
    else param.setValueAtTime(to, now);
  }

  // -------------------------------------------------------------------- music
  bgm(id, ms = 0, vol = 1, loop) {
    if (!this.ctx) this.unlock();
    if (!this.ctx) return;
    const token = ++this.bgmToken;
    const info = id ? this.game.manifest.bgm[id] : null;
    if (!info || vol <= 0) {
      this.bgmState = null;
      this.fadeOutMusic(ms);
      return;
    }
    this.bgmState = { id, vol, loop: loop !== false };
    if (this.current && this.current.id === id) {
      this.current.vol = vol;
      this.ramp(this.current.gain.gain, vol, ms);
      return;
    }
    this.fadeOutMusic(ms);
    this.buffer(info.src, this.music, 2).then((buffer) => {
      if (token !== this.bgmToken) return;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      const gain = this.ctx.createGain();
      gain.gain.value = ms > 0 ? 0 : vol;
      source.connect(gain);
      gain.connect(this.groups.bgm);
      const playing = { id, source, gain, vol };
      if (loop !== false) this.applyLoop(playing);
      source.onended = () => { if (this.current === playing) this.current = null; };
      source.start();
      if (ms > 0) this.ramp(gain.gain, vol, ms);
      this.current = playing;
    }).catch((error) => console.warn('music failed', id, error));
  }

  applyLoop(playing) {
    const info = this.game.manifest.bgm[playing.id];
    const source = playing.source;
    source.loop = true;
    if (this.marks[playing.id] && info && info.loop) {
      source.loopStart = info.loop[0] / 1000;
      source.loopEnd = Math.min(info.loop[1] / 1000, source.buffer.duration);
    }
  }

  /** on: play the intro once, then repeat the marked section of the track. */
  bgmLoop(id, on) {
    if (!id) return;
    if (on) this.marks[id] = true; else delete this.marks[id];
    if (this.current && this.current.id === id && this.current.source.loop) {
      if (on) this.applyLoop(this.current);
      else { this.current.source.loopStart = 0; this.current.source.loopEnd = 0; }
    }
  }

  fadeOutMusic(ms) {
    const playing = this.current;
    if (!playing) return;
    this.current = null;
    this.ramp(playing.gain.gain, 0, ms);
    try { playing.source.stop(this.ctx.currentTime + ms / 1000 + 0.05); } catch (_) { /* already stopped */ }
  }

  // ------------------------------------------------------- sound effects, voice
  se(ch, path, { ms = 0, vol = 1, loop = false, voice = false } = {}) {
    if (!this.ctx) this.unlock();
    if (!this.ctx) return null;
    const key = ch === 255 ? Symbol('one-shot') : ch;      // 255: any free channel
    if (ch !== 255) this.stopChannel(ch, 30);
    const sound = { ch, path, vol, loop, voice, source: null, gain: null, dead: false, ended: null, finish: null };
    sound.ended = new Promise((resolve) => { sound.finish = resolve; });
    this.channels.set(key, sound);
    this.buffer(path).then((buffer) => {
      if (sound.dead) return;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = loop;
      const gain = this.ctx.createGain();
      gain.gain.value = ms > 0 ? 0 : vol;
      source.connect(gain);
      gain.connect(voice ? this.groups.voice : this.groups.se);
      source.onended = () => {
        sound.dead = true;
        sound.finish();
        if (this.channels.get(key) === sound) this.channels.delete(key);
      };
      sound.source = source;
      sound.gain = gain;
      source.start();
      if (ms > 0) this.ramp(gain.gain, vol, ms);
    }).catch((error) => {
      console.warn('sound failed', path, error);
      sound.dead = true;
      sound.finish();
      if (this.channels.get(key) === sound) this.channels.delete(key);
    });
    return sound;
  }

  stopSound(key, sound, ms) {
    if (this.channels.get(key) === sound) this.channels.delete(key);
    if (sound.dead) return;
    sound.dead = true;
    sound.finish();
    if (!sound.source) return;
    this.ramp(sound.gain.gain, 0, ms);
    try { sound.source.stop(this.ctx.currentTime + ms / 1000 + 0.03); } catch (_) { /* already stopped */ }
  }

  stopChannel(ch, ms = 0) {
    const sound = this.channels.get(ch);
    if (sound) this.stopSound(ch, sound, ms);
  }

  /** Fade a channel ("*" = all effect channels). vol 0 stops it. */
  seVol(ch, ms, vol) {
    if (!this.ctx) return;
    for (const [key, sound] of [...this.channels]) {
      if (ch === '*' ? key === LINE : key !== ch) continue;
      if (vol <= 0) this.stopSound(key, sound, ms);
      else if (sound.gain) { sound.vol = vol; this.ramp(sound.gain.gain, vol, ms); }
      else sound.vol = vol;
    }
  }

  /** Voice clip of a text line. Returns a promise that settles when it has finished. */
  voice(path) {
    const sound = this.se(LINE, path, { voice: true });
    return sound ? sound.ended : Promise.resolve();
  }

  stopLineVoice() {
    this.stopChannel(LINE, 40);
  }

  stopVoice() {
    for (const [key, sound] of [...this.channels]) {
      if (sound.voice) this.stopSound(key, sound, 40);
    }
  }

  // -------------------------------------------------------------- save / load
  snapshot() {
    const loops = [];
    for (const [key, sound] of this.channels) {
      if (sound.loop && !sound.dead && typeof key !== 'symbol') {
        loops.push({ ch: sound.ch, src: sound.path, vol: sound.vol, voice: sound.voice });
      }
    }
    return { bgm: this.bgmState && { ...this.bgmState }, marks: { ...this.marks }, loops };
  }

  restore(state) {
    this.stopAll(150);
    this.marks = { ...(state && state.marks) };
    if (state && state.bgm) this.bgm(state.bgm.id, 600, state.bgm.vol, state.bgm.loop);
    for (const loop of (state && state.loops) || []) {
      this.se(loop.ch, loop.src, { ms: 300, vol: loop.vol, loop: true, voice: loop.voice });
    }
  }

  stopAll(ms = 0) {
    if (!this.ctx) return;
    this.bgmToken++;
    this.bgmState = null;
    this.fadeOutMusic(ms);
    for (const [key, sound] of [...this.channels]) this.stopSound(key, sound, ms);
  }
}
