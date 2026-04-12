// =============================================
// utils.js — Shared helpers
// =============================================

// ── Manila (PH) Time ──────────────────────────
function getManilaDate() {
  const now    = new Date();
  const offset = 8 * 60;
  const local  = now.getTimezoneOffset();
  return new Date(now.getTime() + (offset + local) * 60_000);
}

function getDateKey(d) {
  const m = getManilaDate();
  const date = d || m;
  const y  = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const dy = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}`;
}

function formatDate(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  return date.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateShort(dateKey) {
  // "YYYY-MM-DD" → "MM/DD/YYYY"
  const [y, mo, d] = dateKey.split('-');
  return `${mo}/${d}/${y}`;
}

function formatTime12(hh, mm) {
  const period = hh >= 12 ? 'PM' : 'AM';
  const h = hh % 12 || 12;
  return `${h}:${String(mm).padStart(2,'0')} ${period}`;
}

function parseTime12(str) {
  if (!str) return null;
  const match = str.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2]);
  const p = match[3].toUpperCase();
  if (p === 'PM' && h !== 12) h += 12;
  if (p === 'AM' && h === 12) h = 0;
  return { h, m };
}

function timeInputToHm(val) {
  if (!val) return null;
  const [h, m] = val.split(':').map(Number);
  return { h, m };
}

function hmToTimeInput(h, m) {
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function minutesToHm(mins) {
  if (!mins || mins < 0) return '0h 0m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function minutesToDecimal(mins) {
  if (!mins || mins < 0) return '0.00';
  return (mins / 60).toFixed(2);
}

function dayName(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return days[new Date(y, mo - 1, d).getDay()];
}

function getDayIndex(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  return new Date(y, mo - 1, d).getDay();
}

function weekStart(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  const day = date.getDay();
  const diff = (day === 0) ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  const ny = date.getFullYear();
  const nm = String(date.getMonth() + 1).padStart(2, '0');
  const nd = String(date.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

// ── Toast Notifications ──────────────────────
function showToast(msg, type = 'default', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️', default: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span> <span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Modal helpers ────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.add('hidden'); document.body.style.overflow = ''; }
}

// ── Auth guard ───────────────────────────────
function requireAuth(callback) {
  auth.onAuthStateChanged(user => {
    if (!user) {
      window.location.href = 'index.html';
    } else {
      callback(user);
    }
  });
}

// ── Get/cache user settings ──────────────────
let _settings = null;

async function getUserSettings(uid) {
  if (_settings) return _settings;
  try {
    const doc = await db.collection('users').doc(uid).collection('config').doc('settings').get();
    if (doc.exists) {
      _settings = doc.data();
    } else {
      _settings = {
        fullName: '', department: '',
        workStart: '08:00', workEnd: '17:00',
        workDays: [1, 2, 3, 4, 5],
        gracePeriod: 5,
      };
    }
  } catch(e) {
    _settings = {
      fullName: '', department: '',
      workStart: '08:00', workEnd: '17:00',
      workDays: [1, 2, 3, 4, 5],
      gracePeriod: 5,
    };
  }
  return _settings;
}

function clearSettingsCache() { _settings = null; }

// ── Page loader (fancy — full page, auth only) ──
const loaderMessages = [
  'Syncing your records…',
  'Crunching overtime numbers…',
  'Loading your workspace…',
  'Almost there…',
];
let _loaderMsgIdx = 0;
let _loaderMsgTimer = null;

function showLoader() {
  let el = document.getElementById('page-loader');
  if (!el) {
    el = document.createElement('div');
    el.id = 'page-loader';
    el.className = 'page-loader';
    el.innerHTML = `
      <div class="page-loader-icon">⏱</div>
      <div class="loader-dots">
        <div class="loader-dot"></div>
        <div class="loader-dot"></div>
        <div class="loader-dot"></div>
      </div>
      <div class="loader-msg" id="loader-msg">${loaderMessages[0]}</div>`;
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  _loaderMsgIdx = 0;
  _loaderMsgTimer = setInterval(() => {
    _loaderMsgIdx = (_loaderMsgIdx + 1) % loaderMessages.length;
    const msgEl = document.getElementById('loader-msg');
    if (msgEl) msgEl.textContent = loaderMessages[_loaderMsgIdx];
  }, 1800);
}

function hideLoader() {
  clearInterval(_loaderMsgTimer);
  const el = document.getElementById('page-loader');
  if (el) {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => { el.style.display = 'none'; el.style.opacity = ''; el.style.transition = ''; }, 280);
  }
  // Animate content in
  const content = document.querySelector('.page-content');
  if (content) {
    const inner = document.createElement('div');
    inner.className = 'page-content-inner';
    while (content.firstChild) inner.appendChild(content.firstChild);
    content.appendChild(inner);
  }
}

// ── Content loader (partial, stays in content area) ──
function showContentLoader(msg) {
  const content = document.querySelector('.page-content');
  if (!content) return;
  let el = document.getElementById('content-loader');
  if (!el) {
    el = document.createElement('div');
    el.id = 'content-loader';
    el.className = 'content-loader';
    el.innerHTML = `
      <div class="loader-dots">
        <div class="loader-dot"></div>
        <div class="loader-dot"></div>
        <div class="loader-dot"></div>
      </div>
      <div class="loader-msg">${msg || 'Loading…'}</div>`;
    content.appendChild(el);
  } else {
    el.querySelector('.loader-msg').textContent = msg || 'Loading…';
    el.style.display = 'flex';
  }
}

function hideContentLoader() {
  const el = document.getElementById('content-loader');
  if (el) el.style.display = 'none';
}

// ── Sidebar toggle (mobile) ──────────────────
function initSidebar() {
  const toggle   = document.getElementById('sidebar-toggle');
  const sidebar  = document.querySelector('.sidebar');
  const backdrop = document.querySelector('.sidebar-backdrop');
  if (!toggle || !sidebar) return;

  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    if (backdrop) backdrop.classList.toggle('open');
  });
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      sidebar.classList.remove('open');
      backdrop.classList.remove('open');
    });
  }
}

// ── Live Clock ───────────────────────────────
function startLiveClock(timeEl, dateEl) {
  function tick() {
    const now = getManilaDate();
    const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    const period = h >= 12 ? 'PM' : 'AM';
    const dh = h % 12 || 12;
    if (timeEl) timeEl.textContent = `${dh}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')} ${period}`;
    if (dateEl) dateEl.textContent = now.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
  tick();
  return setInterval(tick, 1000);
}

// ── User initials ────────────────────────────
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
