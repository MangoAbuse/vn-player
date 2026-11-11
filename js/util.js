// Small shared helpers.

/** requestAnimationFrame that still fires (slowly) while the page is in the background. */
export function frame(fn) {
  let fired = false;
  const run = () => {
    if (fired) return;
    fired = true;
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    fn(performance.now());
  };
  const raf = requestAnimationFrame(run);
  const timer = setTimeout(run, 120);
}

/** Build a DOM element: h('button', {class: 'x', onclick: fn}, 'Label'). */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child);
  }
  return el;
}

export function formatSize(bytes) {
  if (bytes == null) return '?';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1) + ' GB';
  if (bytes >= 1e6) return Math.round(bytes / 1e6) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
}

export function formatDate(time) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
