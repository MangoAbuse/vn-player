// The app shell: library, title screen, in-game controls, menus, import.

import { h, frame, formatSize, formatDate } from './util.js';
import { BundleError } from './zip.js';
import {
  listGames, openGame, deleteGame, importBundle, storageInfo, cleanUp,
  saves, exportBackup, importBackup, StorageFullError,
} from './store.js';
import { Stage } from './stage.js';
import { TextUI } from './textbox.js';
import { AudioEngine } from './audio.js';
import { Engine } from './engine.js';

const VERSION = '1.0.0';
const SLOTS = 30;
const $ = (selector) => document.querySelector(selector);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ settings
const DEFAULTS = { textSpeed: 45, autoDelay: 1200, fontScale: 1, bgm: 0.6, se: 0.8, voice: 1, skipUnread: false };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('vn-settings') || '{}')); } catch (_) { /* defaults */ }
function saveSettings() {
  try { localStorage.setItem('vn-settings', JSON.stringify(settings)); } catch (_) { /* private mode */ }
}

let session = null;       // the open game: {game, stage, text, audio, engine, backlog, ...}
let blocker = null;       // a movie, staff roll or flash in progress: {cancel, tap?}

function show(name) {
  for (const id of ['library', 'title', 'play']) $('#' + id).hidden = id !== name;
}

// ---------------------------------------------------------- dialogs and toast
function dialog({ title, text, buttons }) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    const close = (value) => { modal.hidden = true; modal.replaceChildren(); resolve(value); };
    modal.replaceChildren(h('div', { class: 'dialog' },
      h('h3', { text: title }),
      text && h('p', { text }),
      h('div', { class: 'row' }, buttons.map((b) => h('button', {
        class: 'button ' + (b.kind || ''), type: 'button', text: b.label, onclick: () => close(b.value),
      }))),
    ));
    modal.hidden = false;
  });
}

const alertBox = (title, text) => dialog({ title, text, buttons: [{ label: 'OK', value: true, kind: 'primary' }] });
const confirmBox = (title, text, ok = 'OK', kind = 'primary') => dialog({
  title, text, buttons: [{ label: 'Cancel', value: false }, { label: ok, value: true, kind }],
});

function progressBox(title) {
  const modal = $('#modal');
  const line = h('p', { text: '' });
  const fill = h('div');
  const bar = h('div', { class: 'bar busy' }, fill);
  modal.replaceChildren(h('div', { class: 'dialog' }, h('h3', { text: title }), line, bar));
  modal.hidden = false;
  return {
    update({ phase, done, total }) {
      if (phase === 'copying' && total) {
        bar.classList.remove('busy');
        fill.style.width = (done / total * 100).toFixed(1) + '%';
        line.textContent = `Copying ${formatSize(done)} of ${formatSize(total)} (${Math.floor(done / total * 100)}%). Keep this page open.`;
      } else {
        bar.classList.add('busy');
        fill.style.width = '';
        line.textContent = phase === 'checking' ? 'Checking the copy…' : 'Reading the bundle…';
      }
    },
    close() { modal.hidden = true; modal.replaceChildren(); },
  };
}

let toastTimer = 0;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function describe(error) {
  if (error instanceof BundleError) return error.message;
  if (error && error.name === 'QuotaExceededError') return 'The device is out of storage space.';
  return String((error && error.message) || error);
}

// -------------------------------------------------------------------- library
async function renderLibrary() {
  const list = $('#games');
  let games = [];
  try { games = await listGames(); } catch (error) {
    list.replaceChildren(h('div', { class: 'empty', text: 'This browser will not let the player store data (private browsing?). ' + describe(error) }));
    return;
  }
  list.replaceChildren();
  if (!games.length) list.append(h('div', { class: 'empty', text: 'No games yet. Import a bundle to start.' }));
  for (const game of games) {
    list.append(h('div', { class: 'game' },
      h('div', { class: 'game-info' },
        h('div', { class: 'game-title', text: game.title }),
        h('div', { class: 'muted small', text: `${formatSize(game.size)} · imported ${formatDate(game.importedAt)}` })),
      h('button', { class: 'button primary', type: 'button', onclick: () => openSession(game.id) }, 'Play'),
      h('button', { class: 'button danger', type: 'button', onclick: () => removeGame(game) }, 'Delete'),
    ));
  }
  const info = await storageInfo();
  const parts = [];
  if (info.usage != null && info.quota != null) parts.push(`Using ${formatSize(info.usage)} of about ${formatSize(info.quota)} this browser allows.`);
  if (info.persisted === true) parts.push('Protected from automatic clean-up.');
  else if (info.persisted === false) parts.push('The system may clear it if the device runs very low on space; keep a backup of your saves.');
  $('#storage-line').textContent = parts.join(' ');
}

async function removeGame(game) {
  const ok = await confirmBox(`Delete ${game.title}?`, `This frees ${formatSize(game.size)}. Your saves are kept, and you can import the bundle again later.`, 'Delete', 'danger');
  if (!ok) return;
  await deleteGame(game.id);
  renderLibrary();
}

async function runImport(file, ignoreEstimate = false) {
  const box = progressBox('Importing ' + file.name);
  let lock = null;
  try { if (navigator.wakeLock) lock = await navigator.wakeLock.request('screen'); } catch (_) { /* optional */ }
  try {
    const record = await importBundle(file, { ignoreEstimate, onProgress: (p) => box.update(p) });
    box.close();
    toast(`${record.title} is ready to play`);
  } catch (error) {
    box.close();
    if (error instanceof StorageFullError) {
      const room = error.free != null ? ` This browser reports room for about ${formatSize(error.free)} more.` : '';
      const again = await dialog({
        title: 'Not enough storage',
        text: `This game needs ${formatSize(error.need)}.${room} Free up space on the device (or delete another game here), then import again.`,
        buttons: error.free != null
          ? [{ label: 'Try anyway', value: true }, { label: 'OK', value: false, kind: 'primary' }]
          : [{ label: 'OK', value: false, kind: 'primary' }],
      });
      if (again) { if (lock) lock.release().catch(() => {}); return runImport(file, true); }
    } else {
      console.error(error);
      await alertBox('Import failed', describe(error));
    }
  } finally {
    if (lock) lock.release().catch(() => {});
  }
  return renderLibrary();
}

$('#import-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) runImport(file);
});

$('#export-saves').addEventListener('click', async () => {
  try {
    const name = `vn-player-saves-${formatDate(Date.now()).slice(0, 10)}.json`;
    const file = new File([await exportBackup()], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    const url = URL.createObjectURL(file);
    const link = h('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) {
    if (error && error.name !== 'AbortError') alertBox('Backup failed', describe(error));
  }
});

$('#restore-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const count = await importBackup(await file.text());
    toast(`Restored ${count} saves`);
  } catch (error) {
    alertBox('Restore failed', describe(error));
  }
});

// ---------------------------------------------------------------- game session
async function openSession(id) {
  try {
    const game = await openGame(id);
    const stage = new Stage(game, $('#scene'));
    const text = new TextUI(game, $('#textlayer'), $('#choices'), settings);
    await text.ready;
    const audio = new AudioEngine(game, settings);
    const engine = new Engine({ game, stage, text, audio, ui: engineUi, settings });
    await engine.init();
    session = { game, stage, text, audio, engine, backlog: [], titleUrl: null, autosaveTimer: 0, playing: false };
    await showTitle();
  } catch (error) {
    console.error(error);
    session = null;
    show('library');
    await alertBox('Cannot open this game', describe(error));
    renderLibrary();
  }
}

async function showTitle() {
  const s = session;
  s.playing = false;
  const art = s.game.manifest.ui && s.game.manifest.ui.title;
  if (art && !s.titleUrl) {
    try { s.titleUrl = URL.createObjectURL(await s.game.zip.blob(art)); } catch (_) { s.titleUrl = null; }
  }
  $('#title-art').style.backgroundImage = s.titleUrl ? `url("${s.titleUrl}")` : 'none';
  $('#title-name').textContent = s.game.manifest.title;
  $('#btn-continue').hidden = !(await saves.get(s.game.id, 'auto').catch(() => null));
  show('title');
}

function enterPlay() {
  const s = session;
  s.playing = true;
  s.backlog = [];
  s.engine.paused = false;
  setCover(false);
  show('play');
  layout();
}

async function toTitle() {
  const s = session;
  if (!s) return;
  await autosaveNow();
  await s.engine.stop();
  s.audio.stopAll(300);
  s.text.hideAll();
  s.stage.reset();
  await showTitle();
}

async function closeSession() {
  const s = session;
  if (!s) return;
  await s.engine.stop();
  await s.engine.flush();
  s.audio.stopAll(100);
  if (s.audio.ctx) setTimeout(() => s.audio.ctx.close().catch(() => {}), 400);
  s.text.dispose();
  if (s.titleUrl) URL.revokeObjectURL(s.titleUrl);
  clearTimeout(s.autosaveTimer);
  session = null;
  show('library');
  renderLibrary();
}

async function storyEnded() {
  const s = session;
  if (!s) return;
  s.playing = false;
  clearTimeout(s.autosaveTimer);
  s.autosaveTimer = 0;
  await saves.del(s.game.id, 'auto').catch(() => {});
  s.audio.stopAll(1200);
  await pause(700);
  if (session !== s) return;
  s.text.hideAll();
  s.stage.reset();
  await showTitle();
}

function saveLabel() {
  const s = session;
  const text = s.engine.disp ? s.engine.disp.text : s.text.plain();
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function autosaveNow() {
  const s = session;
  if (!s) return;
  clearTimeout(s.autosaveTimer);
  s.autosaveTimer = 0;
  if (!s.playing) return;
  const state = s.engine.saveState();
  if (!state) return;
  try {
    await saves.put(s.game.id, 'auto', { time: Date.now(), label: saveLabel(), thumb: s.stage.thumbnail(), state });
  } catch (error) {
    console.warn('autosave failed', error);
  }
  s.engine.flush();
}

// ------------------------------------------------- what the engine asks of the UI
function endBlocker(finish) {
  let over = false;
  const done = () => {
    if (over) return;
    over = true;
    if (blocker === handle) blocker = null;
    finish();
  };
  const handle = { cancel: done };
  blocker = handle;
  return { done, handle };
}

const engineUi = {
  modes() {
    if (!session) return;
    $('#toolbar [data-act=auto]').classList.toggle('on', session.engine.auto);
    $('#toolbar [data-act=skip]').classList.toggle('on', session.engine.skip);
  },

  snapped() {
    const s = session;
    if (s && s.playing && !s.autosaveTimer) s.autosaveTimer = setTimeout(autosaveNow, 4000);
  },

  log(entry) {
    if (!session) return;
    session.backlog.push(entry);
    if (session.backlog.length > 300) session.backlog.shift();
  },

  toast,

  fatal(error) {
    alertBox('The game stopped', describe(error)).then(toTitle);
  },

  ended() { storyEnded(); },

  cancelBlocking() {
    if (blocker) blocker.cancel();
  },

  flash(color, count) {
    return new Promise((resolve) => {
      const el = $('#flash');
      let timer = 0;
      const { done } = endBlocker(() => { clearTimeout(timer); el.style.opacity = '0'; resolve(); });
      let n = 0;
      const once = () => {
        el.style.transition = 'none';
        el.style.background = color;
        el.style.opacity = '1';
        frame(() => { el.style.transition = 'opacity 150ms linear'; el.style.opacity = '0'; });
        timer = setTimeout(++n < count ? once : done, 200);
      };
      once();
    });
  },

  shake(style) {
    const el = $('#shaker');
    el.classList.remove('shake', 'shake-big');
    void el.offsetWidth;                          // restart the animation
    el.classList.add(style >= 4 ? 'shake-big' : 'shake');
    setTimeout(() => el.classList.remove('shake', 'shake-big'), 520);
  },

  async video(src) {
    const video = $('#movie');
    const skip = $('#movie-skip');
    const play = $('#movie-play');
    let url = null;
    let release;
    const finished = new Promise((resolve) => { release = resolve; });
    const { done } = endBlocker(() => {
      video.onended = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.hidden = true;
      skip.hidden = true;
      play.hidden = true;
      $('#play').classList.remove('movie');
      if (url) URL.revokeObjectURL(url);
      release();
    });
    try {
      url = URL.createObjectURL(await session.game.zip.blob(src));
    } catch (error) {
      console.warn('movie failed', error);
      done();
      return finished;
    }
    $('#play').classList.add('movie');
    video.src = url;
    video.hidden = false;
    skip.hidden = false;
    video.onended = done;
    video.onerror = done;
    skip.onclick = (event) => { event.stopPropagation(); done(); };
    // iPad only starts a movie with sound from a tap; if it refuses, ask for one.
    const start = () => video.play().then(() => { play.hidden = true; }, () => { play.hidden = false; });
    play.onclick = (event) => { event.stopPropagation(); start(); };
    start();
    return finished;
  },

  async roll(src, ms, canSkip) {
    const wrap = $('#roll');
    const image = wrap.querySelector('img');
    const skip = $('#movie-skip');
    let url = null;
    let motion = null;
    let release;
    const finished = new Promise((resolve) => { release = resolve; });
    const { done, handle } = endBlocker(() => {
      if (motion) motion.cancel();
      wrap.hidden = true;
      skip.hidden = true;
      image.removeAttribute('src');
      if (url) URL.revokeObjectURL(url);
      $('#play').classList.remove('movie');
      release();
    });
    try {
      url = URL.createObjectURL(await session.game.zip.blob(src));
      image.src = url;
      await image.decode();
    } catch (error) {
      console.warn('staff roll failed', error);
      done();
      return finished;
    }
    if (blocker !== handle) return finished;
    const { w, h: height } = session.game.manifest.screen;
    const tall = image.naturalHeight * w / image.naturalWidth;
    $('#play').classList.add('movie');
    wrap.hidden = false;
    skip.hidden = false;
    skip.onclick = (event) => { event.stopPropagation(); done(); };
    if (canSkip) handle.tap = done;
    motion = image.animate(
      [{ transform: `translateY(${height}px)` }, { transform: `translateY(${-tall}px)` }],
      { duration: ms, easing: 'linear', fill: 'forwards' },
    );
    motion.finished.then(done, () => {});
    return finished;
  },
};

// --------------------------------------------------------------- play screen
function layout() {
  if (!session) return;
  const { w, h: height } = session.game.manifest.screen;
  const scale = Math.min(window.innerWidth / w, window.innerHeight / height);
  const el = $('#stage');
  el.style.width = w + 'px';
  el.style.height = height + 'px';
  el.style.transform = `scale(${scale}) translate(-50%, -50%)`;
  session.stage.resize(scale * (window.devicePixelRatio || 1));
}
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 250));

function setCover(on) {
  $('#play').classList.toggle('cover', on);
}

function stageTap() {
  const s = session;
  if (!s || !s.playing) return;
  s.audio.unlock();
  if ($('#play').classList.contains('cover')) { setCover(false); return; }
  if (blocker && blocker.tap) { blocker.tap(); return; }
  s.engine.tap();
}

$('#play').addEventListener('click', (event) => {
  if (event.target.closest('button, #toolbar')) return;
  stageTap();
});

$('#toolbar').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  const s = session;
  if (!button || !s) return;
  s.audio.unlock();
  const engine = s.engine;
  switch (button.dataset.act) {
    case 'auto': engine.setAuto(!engine.auto); break;
    case 'skip': engine.setSkip(!engine.skip); break;
    case 'log': openLog(); break;
    case 'save': openSaves('save'); break;
    case 'load': openSaves('load'); break;
    case 'hide': setCover(true); break;
    case 'menu': openSettings(); break;
    default:
  }
});

document.addEventListener('keydown', (event) => {
  if (!$('#modal').hidden) return;
  if (!$('#overlay').hidden) {
    if (event.key === 'Escape') closeOverlay();
    return;
  }
  if (event.key === ' ' || event.key === 'Enter') {
    if (session && session.playing && !event.target.closest('button')) { event.preventDefault(); stageTap(); }
  }
});

document.addEventListener('visibilitychange', () => {
  const s = session;
  if (!s) return;
  if (document.hidden) {
    autosaveNow();
    s.audio.suspend();
  } else if (s.audio.ctx && s.playing) {
    s.audio.ctx.resume().catch(() => {});
  }
});
window.addEventListener('pagehide', () => { autosaveNow(); });

// -------------------------------------------------------------------- menus
function openOverlay(title, body) {
  const overlay = $('#overlay');
  overlay.replaceChildren(
    h('div', { class: 'sheet-head' },
      h('h2', { text: title }),
      h('button', { class: 'button', type: 'button', onclick: closeOverlay }, 'Close')),
    body,
  );
  overlay.hidden = false;
  if (session) session.engine.setPaused(true);
}

function closeOverlay() {
  const overlay = $('#overlay');
  overlay.hidden = true;
  overlay.replaceChildren();
  if (session) session.engine.setPaused(false);
}

function openLog() {
  const s = session;
  const list = h('div', { class: 'log' });
  if (!s.backlog.length) list.append(h('p', { class: 'muted', text: 'Nothing here yet.' }));
  for (const entry of s.backlog) {
    list.append(h('div', { class: 'log-entry' },
      entry.voice && h('button', {
        class: 'log-voice', type: 'button', title: 'Play voice', onclick: () => s.audio.voice(entry.voice),
      }, '▶'),
      entry.who && h('div', { class: 'log-who', text: entry.who }),
      h('div', { class: 'log-text', text: entry.text }),
    ));
  }
  const body = h('div', { class: 'sheet-body' }, list);
  openOverlay('Backlog', body);
  body.scrollTop = body.scrollHeight;
}

async function openSaves(mode) {
  const s = session;
  const records = new Map((await saves.list(s.game.id)).map((r) => [r.slot, r]));
  const numbers = Array.from({ length: SLOTS }, (_, i) => i + 1);
  const grid = h('div', { class: 'slots' });

  const pick = async (slot, record) => {
    try {
      if (mode === 'save') {
        const state = s.engine.saveState();
        if (!state) { toast('Nothing to save yet'); return; }
        if (record && !(await confirmBox('Overwrite this save?', '', 'Overwrite'))) return;
        await saves.put(s.game.id, slot, { time: Date.now(), label: saveLabel(), thumb: s.stage.thumbnail(), state });
        closeOverlay();
        toast('Saved in slot ' + slot);
      } else if (record) {
        if (s.playing && !(await confirmBox('Load this save?', 'Anything since your last save is lost.', 'Load'))) return;
        closeOverlay();
        enterPlay();
        await s.engine.load(record.state);
      }
    } catch (error) {
      console.error(error);
      alertBox(mode === 'save' ? 'Could not save' : 'Could not load', describe(error));
    }
  };

  for (const slot of mode === 'load' ? ['auto', ...numbers] : numbers) {
    const record = records.get(slot);
    const name = slot === 'auto' ? 'Autosave' : 'Slot ' + slot;
    const card = h('button', { class: 'slot' + (record ? '' : ' empty-slot'), type: 'button', onclick: () => pick(slot, record) },
      h('div', { class: 'slot-thumb', style: record && record.thumb ? { backgroundImage: `url("${record.thumb}")` } : {} }),
      h('div', { class: 'slot-info' },
        h('div', { class: 'slot-name', text: record ? `${name} · ${formatDate(record.time)}` : name }),
        h('div', { class: 'slot-label', text: record ? record.label || '' : 'Empty' })),
    );
    if (record && slot !== 'auto') {
      card.append(h('span', {
        class: 'slot-delete', role: 'button', title: 'Delete this save',
        onclick: async (event) => {
          event.stopPropagation();
          if (!(await confirmBox(`Delete ${name}?`, '', 'Delete', 'danger'))) return;
          await saves.del(s.game.id, slot);
          openSaves(mode);
        },
      }, '✕'));
    }
    grid.append(card);
  }
  openOverlay(mode === 'save' ? 'Save' : 'Load', h('div', { class: 'sheet-body' }, grid));
}

function openSettings() {
  const s = session;
  const percent = (v) => Math.round(v * 100) + '%';
  const slider = (label, key, min, max, step, format, apply) => {
    const out = h('output', { text: format(settings[key]) });
    const input = h('input', { type: 'range', min, max, step });
    input.value = settings[key];
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      out.textContent = format(settings[key]);
      saveSettings();
      if (apply) apply(settings[key]);
    });
    return h('div', { class: 'setting' }, h('label', {}, label, out), input);
  };
  const volume = (label, key) => slider(label, key, 0, 1, 0.05, percent, (v) => { if (s) s.audio.setVolume(key, v); });
  const unread = h('input', { type: 'checkbox' });
  unread.checked = settings.skipUnread;
  unread.addEventListener('change', () => { settings.skipUnread = unread.checked; saveSettings(); });

  const body = h('div', { class: 'sheet-body' }, h('div', { class: 'settings' },
    slider('Text speed', 'textSpeed', 15, 125, 5, (v) => (v >= 125 ? 'Instant' : v + ' letters a second')),
    slider('Auto mode: pause after each line', 'autoDelay', 300, 4000, 100, (v) => (v / 1000).toFixed(1) + ' s'),
    slider('Text size', 'fontScale', 0.8, 1.4, 0.05, percent),
    volume('Music volume', 'bgm'),
    volume('Sound effects volume', 'se'),
    volume('Voice volume', 'voice'),
    h('div', { class: 'setting check' }, h('label', {}, unread, 'Skip also passes text I have not read yet')),
    s && s.playing && h('div', { class: 'row' },
      h('button', { class: 'button', type: 'button', onclick: async () => { closeOverlay(); await toTitle(); } }, 'Back to title')),
    h('p', { class: 'muted small', text: `VN Player ${VERSION}` }),
  ));
  openOverlay('Settings', body);
}

// --------------------------------------------------------------- title screen
$('#btn-start').addEventListener('click', async () => {
  const s = session;
  if (!s) return;
  s.audio.unlock();
  if (!$('#btn-continue').hidden) {
    const ok = await confirmBox('Start from the beginning?', 'Your save slots are kept; "Continue" will follow the new game.', 'Start');
    if (!ok) return;
  }
  enterPlay();
  await s.engine.newGame();
});

$('#btn-continue').addEventListener('click', async () => {
  const s = session;
  if (!s) return;
  s.audio.unlock();
  const record = await saves.get(s.game.id, 'auto');
  if (!record) return;
  enterPlay();
  await s.engine.load(record.state);
});

$('#btn-load').addEventListener('click', () => { if (session) { session.audio.unlock(); openSaves('load'); } });
$('#btn-settings').addEventListener('click', () => openSettings());
$('#btn-library').addEventListener('click', () => closeSession());

// --------------------------------------------------------------------- start
const standalone = window.navigator.standalone === true
  || window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: fullscreen)').matches;
const appleTouch = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
$('#install-hint').hidden = !(appleTouch && !standalone);

if ('serviceWorker' in navigator) {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!local || new URLSearchParams(location.search).has('sw')) {
    navigator.serviceWorker.register('sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(() => { $('#offline-line').textContent = `Version ${VERSION}. Ready to work offline.`; })
      .catch(() => { $('#offline-line').textContent = `Version ${VERSION}. Offline use is not available in this browser.`; });
  } else {
    $('#offline-line').textContent = `Version ${VERSION} (development server, offline cache off).`;
  }
}

cleanUp().then(renderLibrary, renderLibrary);

// For testing from the browser console.
window.vn = {
  get session() { return session; },
  settings,
  async importFromUrl(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    return runImport(new File([blob], url.split('/').pop(), { type: 'application/zip' }));
  },
};
