// Fintel – floating help assistant, included on every page with <script src="/fintel.js" defer>.
// Add data-theme="dark" on the script tag for pages that are always dark (front page, sign-in);
// otherwise the panel follows the app's light/dark setting.
// It sends the question, a description of the page (headings, field labels, the field the user
// last clicked) and the recent chat to /api/fintel. Typed values are never sent, only whether a
// field is filled in.
(() => {
  if (window.__fintel) return;
  window.__fintel = true;
  const script = document.currentScript;
  const forceDark = script?.dataset.theme === 'dark';
  const STORE = 'fintel-chat';
  const MAX_KEEP = 20;

  const css = `
.fintel { --fx-accent: #6e1f2a; --fx-accent-ink: #fff7ea; --fx-gold: #b8955a; --fx-bg: #fffdf8; --fx-bg-2: #f6f1e6; --fx-ink: #1f2a2e; --fx-muted: #6b716e;
  --fx-line: #e4dccb; --fx-me: #6e1f2a; --fx-me-ink: #fff7ea; --fx-bot: #f3ece0; --fx-err: #b3261e; --fx-shadow: 0 18px 48px -18px rgba(27, 8, 11, .45), 0 2px 6px rgba(27, 8, 11, .08);
  font: 14px/1.5 Inter, system-ui, -apple-system, sans-serif; color: var(--fx-ink); -webkit-font-smoothing: antialiased; }
.fintel.dark { --fx-accent: #d9c08f; --fx-accent-ink: #1b080b; --fx-gold: #d9c08f; --fx-bg: #24100f; --fx-bg-2: #1b080b; --fx-ink: #efe6d6; --fx-muted: #b9a693;
  --fx-line: rgba(217, 192, 143, .22); --fx-me: #d9c08f; --fx-me-ink: #1b080b; --fx-bot: #321519; --fx-err: #ff9b8f; --fx-shadow: 0 18px 48px -14px rgba(0, 0, 0, .7); }
.fintel *, .fintel *::before, .fintel *::after { box-sizing: border-box; }
.fintel-launch { position: fixed; right: 20px; bottom: 20px; z-index: 60; display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 20px 0 14px;
  border: 1px solid rgba(217, 192, 143, .55); border-radius: 999px; background: linear-gradient(135deg, #3a161b, #1b080b); color: #f3e4c0;
  font: 600 14px/1 Inter, system-ui, sans-serif; letter-spacing: .01em; cursor: pointer; box-shadow: var(--fx-shadow); transition: transform .15s ease, box-shadow .15s ease; }
.fintel-launch:hover { transform: translateY(-2px); }
.fintel-launch:focus-visible, .fintel button:focus-visible, .fintel textarea:focus-visible { outline: 2px solid var(--fx-gold); outline-offset: 2px; }
.fintel-launch svg { width: 24px; height: 24px; flex: none; }
.fintel-launch[aria-expanded="true"] { display: none; }
.fintel-panel { position: fixed; right: 20px; bottom: 20px; z-index: 61; width: 380px; height: min(600px, calc(100vh - 40px)); display: flex; flex-direction: column;
  background: var(--fx-bg); border: 1px solid var(--fx-line); border-radius: 18px; box-shadow: var(--fx-shadow); overflow: hidden;
  transform-origin: bottom right; animation: fintel-in .18s ease-out; }
.fintel-panel[hidden] { display: none; }
@keyframes fintel-in { from { opacity: 0; transform: translateY(8px) scale(.98); } }
@media (prefers-reduced-motion: reduce) { .fintel-panel { animation: none; } .fintel-launch { transition: none; } }
.fintel-head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 16px; background: linear-gradient(135deg, #3a161b, #1b080b); color: #f3e4c0; }
.fintel-head .av { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: rgba(217, 192, 143, .16); border: 1px solid rgba(217, 192, 143, .45); flex: none; }
.fintel-head .av svg { width: 20px; height: 20px; }
.fintel-head b { display: block; font: 600 17px/1.2 Fraunces, Georgia, serif; letter-spacing: .01em; }
.fintel-head small { display: block; font-size: 12px; color: #c9b493; }
.fintel-head .sp { flex: 1; min-width: 0; }
.fintel-icon { width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: #f3e4c0; cursor: pointer; }
.fintel-icon:hover { background: rgba(217, 192, 143, .14); }
.fintel-icon svg { width: 18px; height: 18px; }
.fintel-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: var(--fx-bg); overscroll-behavior: contain; }
.fintel-msg { max-width: 88%; padding: 9px 12px; border-radius: 14px; overflow-wrap: anywhere; }
.fintel-msg.bot { align-self: flex-start; background: var(--fx-bot); border-bottom-left-radius: 4px; }
.fintel-msg.me { align-self: flex-end; background: var(--fx-me); color: var(--fx-me-ink); border-bottom-right-radius: 4px; white-space: pre-wrap; }
.fintel-msg.err { align-self: flex-start; background: transparent; border: 1px solid var(--fx-err); color: var(--fx-err); }
.fintel-msg p { margin: 0 0 6px; } .fintel-msg p:last-child { margin: 0; }
.fintel-msg ul, .fintel-msg ol { margin: 4px 0 6px; padding-left: 18px; } .fintel-msg li { margin: 2px 0; }
.fintel-msg code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(127, 127, 127, .16); padding: 1px 4px; border-radius: 4px; }
.fintel-about { font-size: 11.5px; color: var(--fx-muted); margin-top: -4px; }
.fintel-typing { display: inline-flex; gap: 4px; padding: 4px 0; }
.fintel-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--fx-muted); animation: fintel-dot 1s infinite ease-in-out; }
.fintel-typing i:nth-child(2) { animation-delay: .15s; } .fintel-typing i:nth-child(3) { animation-delay: .3s; }
@keyframes fintel-dot { 0%, 80%, 100% { opacity: .3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
.fintel-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.fintel-chip { border: 1px solid var(--fx-line); background: var(--fx-bg-2); color: var(--fx-ink); border-radius: 999px; padding: 6px 11px; font: 500 12.5px/1.3 Inter, system-ui, sans-serif; cursor: pointer; text-align: left; }
.fintel-chip:hover { border-color: var(--fx-gold); }
.fintel-foot { border-top: 1px solid var(--fx-line); padding: 10px 12px 12px; background: var(--fx-bg); }
.fintel-focus { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fx-muted); margin-bottom: 8px; min-width: 0; }
.fintel-focus[hidden] { display: none; }
.fintel-focus span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.fintel-focus b { color: var(--fx-ink); font-weight: 600; }
.fintel-focus button { border: 0; background: none; color: var(--fx-muted); cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1; flex: none; }
.fintel-form { display: flex; gap: 8px; align-items: flex-end; }
.fintel-form textarea { flex: 1; resize: none; min-height: 42px; max-height: 120px; padding: 10px 12px; border: 1px solid var(--fx-line); border-radius: 12px;
  background: var(--fx-bg-2); color: var(--fx-ink); font: 14px/1.4 Inter, system-ui, sans-serif; }
.fintel-form textarea::placeholder { color: var(--fx-muted); }
.fintel-send { width: 42px; height: 42px; flex: none; display: grid; place-items: center; border: 0; border-radius: 12px; background: var(--fx-accent); color: var(--fx-accent-ink); cursor: pointer; }
.fintel-send:disabled { opacity: .5; cursor: default; }
.fintel-send svg { width: 18px; height: 18px; }
.fintel-note { margin: 8px 2px 0; font-size: 11px; color: var(--fx-muted); }
@media (max-width: 520px) {
  .fintel-launch { right: 16px; bottom: 16px; width: 52px; padding: 0; justify-content: center; }
  .fintel-launch span { display: none; }
  .fintel-panel { right: 0; bottom: 0; width: 100%; height: 100%; max-height: 100dvh; border-radius: 0; border: 0; }
}`;

  const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
  const html = `
  <button class="fintel-launch" type="button" aria-expanded="false" aria-controls="fintel-panel">${SPARK}<span>Ask Fintel</span></button>
  <section class="fintel-panel" id="fintel-panel" role="dialog" aria-label="Fintel assistant" hidden>
    <header class="fintel-head">
      <span class="av">${SPARK}</span>
      <span class="sp"><b>Fintel</b><small>Your help with any field on this page</small></span>
      <button class="fintel-icon" type="button" data-act="clear" title="Start a new chat" aria-label="Start a new chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg></button>
      <button class="fintel-icon" type="button" data-act="close" title="Close" aria-label="Close Fintel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <div class="fintel-log" aria-live="polite"></div>
    <div class="fintel-foot">
      <div class="fintel-focus" hidden><span>Asking about <b></b></span><button type="button" title="Don't use this field" aria-label="Don't use this field">×</button></div>
      <form class="fintel-form">
        <textarea rows="1" placeholder="Ask about any field or step…" aria-label="Your question for Fintel" maxlength="1000"></textarea>
        <button class="fintel-send" type="submit" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
      </form>
      <p class="fintel-note">Fintel explains the forms. For fund facts with sources, use Research. Not investment advice.</p>
    </div>
  </section>`;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const root = document.createElement('div');
  root.className = 'fintel';
  root.innerHTML = html;
  document.body.append(root);

  const $ = (s) => root.querySelector(s);
  const launch = $('.fintel-launch'), panel = $('.fintel-panel'), log = $('.fintel-log');
  const form = $('.fintel-form'), input = $('textarea'), send = $('.fintel-send');
  const focusBar = $('.fintel-focus');

  // ---------- Theme ----------
  const mq = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = document.documentElement.dataset.theme;
    root.classList.toggle('dark', forceDark || t === 'dark' || (t !== 'light' && mq.matches));
  }
  applyTheme();
  mq.addEventListener?.('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------- Chat history (this browser tab, kept across pages) ----------
  let chat = [];
  try { chat = JSON.parse(sessionStorage.getItem(STORE) || '[]'); } catch { chat = []; }
  if (!Array.isArray(chat)) chat = [];
  const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(chat.slice(-MAX_KEEP))); } catch {} };

  // ---------- Reading the page ----------
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
  const isControl = (n) => n.nodeType === 1 && (n.matches('input, select, textarea, button') || n.querySelector('input, select, textarea'));

  function labelOf(el) {
    let lab = el.closest('label');
    if (!lab && el.id) lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    let t = lab ? clean([...lab.childNodes].filter((n) => !isControl(n)).map((n) => n.textContent).join(' ')) : '';
    if (!t) t = clean(el.getAttribute('aria-label'));
    const td = el.closest('td');
    if (!t && td) {
      // Table inputs (e.g. the goals table): column heading + row number.
      const th = td.closest('table')?.querySelectorAll('thead th')[td.cellIndex];
      const row = td.parentElement.rowIndex;
      if (th && clean(th.textContent)) t = `${clean(th.textContent)} (row ${row})`;
    }
    if (!t) t = clean(el.placeholder);
    if (!t) t = clean(el.name || el.id);
    const legend = clean(el.closest('fieldset')?.querySelector('legend')?.textContent);
    return legend && t ? `${t} [section: ${legend}]` : t;
  }

  // What the user typed (client names, amounts, notes) stays in the browser: only whether a
  // field is filled in is sent. Dropdowns send their current choice, which is one of the options.
  function describe(el) {
    const f = { label: labelOf(el), required: el.required || undefined };
    if (el.tagName === 'SELECT') {
      f.options = [...el.options].map((o) => clean(o.textContent)).filter(Boolean);
      f.value = clean(el.selectedOptions[0]?.textContent);
    } else if (el.type !== 'file' && el.type !== 'hidden') {
      f.filled = el.value.trim() !== '' || undefined;
    }
    return f;
  }

  let focused = null;
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (root.contains(el) || !el.matches?.('input, select, textarea') || ['hidden', 'submit', 'button'].includes(el.type)) return;
    focused = el;
    showFocus();
  });
  function showFocus() {
    const ok = focused && focused.isConnected && visible(focused);
    if (!ok) focused = null;
    focusBar.hidden = !focused;
    if (focused) $('.fintel-focus b').textContent = labelOf(focused).replace(/ \[section: .*\]$/, '');
  }
  $('.fintel-focus button').addEventListener('click', () => { focused = null; showFocus(); input.focus(); });

  function pageInfo() {
    const fields = [...document.querySelectorAll('input, select, textarea')]
      .filter((el) => !root.contains(el) && visible(el) && !['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type))
      .slice(0, 60).map(describe);
    return {
      title: document.title,
      path: location.pathname + location.hash,
      screen: clean(document.querySelector('#steps [aria-current="page"]')?.textContent),
      headings: [...document.querySelectorAll('main h1, main h2, main h3, main legend, h1')]
        .filter((h) => !root.contains(h) && visible(h)).map((h) => clean(h.textContent)).filter((t, i, a) => t && a.indexOf(t) === i).slice(0, 12),
      fields,
      focused: focused && focused.isConnected ? labelOf(focused) : '',
    };
  }

  // ---------- Rendering ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  function md(text) {
    const out = [];
    let list = null;
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (bullet) {
        const kind = /^\d/.test(line) ? 'ol' : 'ul';
        if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }
      if (list) { out.push(`</${list}>`); list = null; }
      if (line) out.push(`<p>${inline(line.replace(/^#{1,6}\s+/, ''))}</p>`);
    }
    if (list) out.push(`</${list}>`);
    return out.join('');
  }

  function bubble(m) {
    const d = document.createElement('div');
    d.className = `fintel-msg ${m.role === 'user' ? 'me' : m.error ? 'err' : 'bot'}`;
    if (m.role === 'user') d.textContent = m.content; else d.innerHTML = md(m.content);
    return d;
  }

  function suggestions() {
    const p = location.pathname;
    const f = focused && focused.isConnected ? labelOf(focused).replace(/ \[section: .*\]$/, '') : '';
    const list = [];
    if (f) list.push(`What should I enter in "${f}"?`);
    if (p === '/' || p.endsWith('index.html')) list.push('What does Fin Advisor do?', 'How do I get started?');
    else {
      const screen = clean(document.querySelector('#steps [aria-current="page"]')?.textContent).replace(/^\d+/, '');
      if (screen) list.push(`Explain the ${screen} screen`);
      list.push('Which fields are required?', 'Risk capacity vs risk tolerance?', 'How do I enter ₹25 lakh?');
    }
    return list.slice(0, 4);
  }

  function render() {
    log.replaceChildren();
    const hello = document.createElement('div');
    hello.className = 'fintel-msg bot';
    hello.innerHTML = md("Hi, I'm **Fintel**. Stuck on a field? Click it, then ask me what it means or what to enter.");
    log.append(hello);
    if (!chat.length) {
      const chips = document.createElement('div');
      chips.className = 'fintel-chips';
      for (const s of suggestions()) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'fintel-chip'; b.textContent = s;
        b.addEventListener('click', () => ask(s));
        chips.append(b);
      }
      log.append(chips);
    }
    for (const m of chat) {
      log.append(bubble(m));
      if (m.about) { const a = document.createElement('div'); a.className = 'fintel-about'; a.style.alignSelf = 'flex-end'; a.textContent = `about: ${m.about}`; log.append(a); }
    }
    log.scrollTop = log.scrollHeight;
  }

  // ---------- Asking ----------
  let busy = false;
  async function ask(text) {
    const q = clean(text);
    if (!q || busy) return;
    busy = true; send.disabled = true;
    const page = pageInfo();
    const history = chat.filter((m) => !m.error).slice(-8).map(({ role, content }) => ({ role, content }));
    chat.push({ role: 'user', content: q, about: page.focused ? page.focused.replace(/ \[section: .*\]$/, '') : undefined });
    save(); render();
    input.value = ''; autosize();
    const typing = document.createElement('div');
    typing.className = 'fintel-msg bot';
    typing.innerHTML = '<span class="fintel-typing" aria-label="Fintel is typing"><i></i><i></i><i></i></span>';
    log.append(typing); log.scrollTop = log.scrollHeight;
    try {
      const r = await fetch('/api/fintel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, page, history }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Fintel could not answer just now. Please try again.');
      chat.push({ role: 'assistant', content: j.answer });
    } catch (e) {
      chat.push({ role: 'assistant', content: e.message === 'Failed to fetch' ? 'Could not reach the server. Check your connection and try again.' : e.message, error: true });
    } finally {
      busy = false; send.disabled = false;
      save(); render();
      if (!panel.hidden) input.focus();
    }
  }

  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });

  // ---------- Open / close ----------
  function open() {
    panel.hidden = false; launch.setAttribute('aria-expanded', 'true');
    showFocus(); render(); input.focus();
  }
  function close() {
    panel.hidden = true; launch.setAttribute('aria-expanded', 'false');
    if (focused?.isConnected) focused.focus({ preventScroll: true }); else launch.focus();
  }
  // Keep the launcher from taking focus away from the field the user is asking about.
  launch.addEventListener('mousedown', (e) => e.preventDefault());
  launch.addEventListener('click', open);
  $('[data-act="close"]').addEventListener('click', close);
  $('[data-act="clear"]').addEventListener('click', () => { chat = []; save(); render(); input.focus(); });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  addEventListener('hashchange', () => { if (!panel.hidden) { showFocus(); if (!chat.length) render(); } });
})();
