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

// Converts an <input type="week"> value ("YYYY-Www") into a { start, end } date-key range (Mon–Sun, ISO week)
function isoWeekToDateRange(weekStr) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekStr || '');
  if (!match) return null;
  const year = parseInt(match[1]);
  const week = parseInt(match[2]);
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7; // Mon=1..Sun=7
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - (jan4Day - 1));
  const start = new Date(week1Monday);
  start.setDate(week1Monday.getDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return { start: fmt(start), end: fmt(end) };
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
      const data = doc.data();
      // Fill in any missing defaults so the app never gets null for critical fields
      _settings = {
        fullName:       data.fullName       || '',
        username:       data.username       || '',
        department:     data.department     || '',
        companyName:    data.companyName    || '',
        jobPosition:    data.jobPosition    || data.department || '',
        userType:       data.userType       || 'employee',
        requiredRenderHours: data.requiredRenderHours ?? null,
        workStart:      data.workStart      || '08:00',
        workEnd:        data.workEnd        || '17:00',
        breakHours:     data.breakHours     ?? 0,
        workDays:       data.workDays       || [1, 2, 3, 4, 5],
        gracePeriod:    data.gracePeriod    ?? 5,
        isNewUser:      data.isNewUser      || false,
        multiSchedule:  data.multiSchedule  || false,
        perDaySchedule: data.perDaySchedule || {},
        otToLeaveHours: data.otToLeaveHours || null,
        otCountingRule: data.otCountingRule || { startRule: 'immediate', delayMins: 0, incrementMins: 1 },
        notifSettings:  data.notifSettings  || { shiftWarnMins: 5, otRemindFreq: 'daily', timeoutRemindFreq: '60' },
      };
    } else {
      _settings = {
        fullName: '', username: '', department: '',
        companyName: '', jobPosition: '', userType: 'employee', requiredRenderHours: null,
        workStart: '08:00', workEnd: '17:00', breakHours: 0,
        workDays: [1, 2, 3, 4, 5],
        gracePeriod: 5, isNewUser: true,
      };
    }
  } catch(e) {
    _settings = {
      fullName: '', username: '', department: '',
      companyName: '', jobPosition: '', userType: 'employee', requiredRenderHours: null,
      workStart: '08:00', workEnd: '17:00', breakHours: 0,
      workDays: [1, 2, 3, 4, 5],
      gracePeriod: 5, isNewUser: false,
    };
  }
  return _settings;
}

// Applies a company's OT counting rule to raw overtime minutes.
// Shared by dashboard.js, overtime.js and attendance.js so OT math stays consistent everywhere.
function applyOTCountingRule(rawOTMins, rule) {
  rule = rule || { startRule: 'immediate', delayMins: 0, incrementMins: 1 };
  if (rawOTMins <= 0) return 0;
  if (rule.startRule === 'immediate') return rawOTMins;
  const delay = rule.delayMins || 0;
  const incr  = rule.incrementMins || 1;
  if (rawOTMins < delay) return 0;
  const afterDelay = rawOTMins - delay;
  return delay + Math.floor(afterDelay / incr) * incr;
}

// OT is pooled — it doesn't matter which specific day a usage "draws from". Earned OT is the sum
// of every record's otMinutes; used OT is the sum of otUsageMins on every record that has an
// otUsageType set (however it was declared: Full Day Leave, Half Day, or Undertime). Deleting or
// undoing either side naturally updates the remaining total, since it's derived fresh each time
// rather than tracked via a separate flag.
function getOTPool(records) {
  const earned = records.reduce((s, r) => s + (r.otMinutes || 0), 0);
  const used   = records.reduce((s, r) => s + (r.otUsageType ? (r.otUsageMins || 0) : 0), 0);
  return { earned, used, remaining: earned - used };
}

// Short/full display labels for OT usage codes. The stored code for Undertime stays 'LATE-OT'
// (so old records keep working) — only the label shown to the user changed.
function otUsageShortLabel(code) {
  if (code === 'FL-OT')   return 'FL-OT';
  if (code === 'HD-OT')   return 'HD-OT';
  if (code === 'LATE-OT') return 'UT-OT';
  return code || 'N/A';
}
function otUsageFullLabel(code) {
  if (code === 'FL-OT')   return 'Full Day Leave (FL-OT)';
  if (code === 'HD-OT')   return 'Half Day (HD-OT)';
  if (code === 'LATE-OT') return 'Undertime (UT-OT)';
  return code || 'N/A';
}

// Recomputes "present" records' Work Hours / Overtime using the CURRENT schedule (Work Start/End,
// Breaktime Hours, OT rule) — or the record's own per-date override, if one was set — instead of
// trusting whatever was stored at save time. This is what makes editing the Schedule retroactively
// update Work Hours shown across Attendance, Overtime, and the Dashboard, without needing to
// re-save every past record. Records that aren't "present" (absent/holiday/pending/ot-leave) are
// left untouched — those aren't clock-based, so old data for them is unaffected.
// Existing users with no breakHours saved yet are unaffected (treated as 0 minutes of break).
// Time In: uses the record's own logged Time In if set, else defaults to the effective Work Start
// (per-day override or schedule) — old records with no Time In saved fall back the same way they
// always implicitly did, so nothing changes for them.
// "Work Hours" reported here is the TOTAL time physically worked — actual Time In to Time Out,
// minus break, PLUS any overtime — for every user, employee or intern. Overtime is still anchored
// to Work End (not Time In) and returned separately too, for screens that show OT on its own.
function applyEffectiveMinutes(records, userSettings) {
  return records.map(rec => {
    if (rec.status !== 'present' || !rec.timeOutDisplay) return rec;
    const outParsed = parseTime12(rec.timeOutDisplay);
    if (!outParsed) return rec;

    const workStart = rec.customWorkStart || userSettings.workStart || '08:00';
    const workEnd   = rec.customWorkEnd   || userSettings.workEnd   || '17:00';
    const e = timeInputToHm(workEnd);
    if (!e) return rec;

    // Time In: what they actually logged for that day, else the effective schedule start
    const inDisplay = rec.timeInDisplay || null;
    const inParsed  = inDisplay ? parseTime12(inDisplay) : timeInputToHm(workStart);
    if (!inParsed) return rec;

    const breakMins = Math.max(0, Math.round((userSettings.breakHours || 0) * 60));
    const base = new Date();
    const toMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), outParsed.h, outParsed.m, 0).getTime();
    const inMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), inParsed.h, inParsed.m, 0).getTime();
    const eMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();

    const rawWorkMins = Math.round((Math.min(toMs, eMs) - inMs) / 60_000);
    const baseWorkMinutes = Math.max(0, rawWorkMins - breakMins);
    const otRaw       = Math.max(0, Math.round((toMs - eMs) / 60_000));
    const otMinutes   = applyOTCountingRule(otRaw, userSettings.otCountingRule);
    const workMinutes = baseWorkMinutes + otMinutes;

    return { ...rec, workMinutes, otMinutes };
  });
}

function clearSettingsCache() { _settings = null; }

// ── Page loader — skeleton style ──
// Keeps the topbar (hamburger, title, notif icon, live clock) and sidebar visible;
// only the content area shows shimmering skeleton placeholders while data loads.
// Used the same way on every tab, on both mobile and desktop.
function skeletonMarkup() {
  return `
    <div class="skeleton-row">
      <div class="skeleton-block skel-card"></div>
      <div class="skeleton-block skel-card"></div>
      <div class="skeleton-block skel-card"></div>
      <div class="skeleton-block skel-card"></div>
    </div>
    <div class="skel-panel">
      <div class="skeleton-block skel-bar" style="width:35%;margin-bottom:1rem"></div>
      <div class="skeleton-block skel-bar-lg" style="margin-bottom:.6rem"></div>
      <div class="skeleton-block skel-bar-lg" style="margin-bottom:.6rem"></div>
      <div class="skeleton-block skel-bar-lg" style="margin-bottom:.6rem"></div>
      <div class="skeleton-block skel-bar-lg"></div>
    </div>`;
}

function showLoader() {
  let el = document.getElementById('page-loader');
  if (!el) {
    el = document.createElement('div');
    el.id = 'page-loader';
    el.className = 'page-loader';
    document.body.appendChild(el);
  }
  el.innerHTML = skeletonMarkup();
  el.style.display = 'block';
  el.style.opacity = '1';
}

function hideLoader() {
  const el = document.getElementById('page-loader');
  if (el) {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => { el.style.display = 'none'; el.style.opacity = ''; el.style.transition = ''; el.innerHTML = ''; }, 280);
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

// ── Sign out (shared across all pages) ────────
// Shows a themed confirm dialog (same modal styling as Edit/Delete confirmations),
// then a full-screen loading state while Firebase signs out.
function confirmAndSignOut() {
  let el = document.getElementById('signout-confirm-modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'signout-confirm-modal';
    el.className = 'modal-overlay hidden';
    el.innerHTML = `
      <div class="modal" style="max-width:380px">
        <div class="modal-header">
          <span class="modal-title">Sign Out</span>
          <button class="modal-close" onclick="closeModal('signout-confirm-modal')">✕</button>
        </div>
        <div class="modal-body">
          <p style="font-size:.88rem;color:var(--text)">Are you sure you want to sign out?</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal('signout-confirm-modal')">Cancel</button>
          <button class="btn btn-danger" onclick="executeSignOut()">Sign Out</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) closeModal('signout-confirm-modal'); });
  }
  openModal('signout-confirm-modal');
}

function executeSignOut() {
  closeModal('signout-confirm-modal');

  let el = document.getElementById('signout-loader');
  if (!el) {
    el = document.createElement('div');
    el.id = 'signout-loader';
    el.className = 'signout-loader';
    el.innerHTML = `
      <div class="spinner"></div>
      <div class="signout-loader-msg">Signing you out…</div>`;
    document.body.appendChild(el);
  }
  el.style.display = 'flex';

  auth.signOut().finally(() => { window.location.href = 'index.html'; });
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
    if (dateEl) {
      const longFmt  = now.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const days     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const mo       = String(now.getMonth() + 1).padStart(2, '0');
      const dy       = String(now.getDate()).padStart(2, '0');
      const shortFmt = `${days[now.getDay()]}, ${mo}/${dy}/${now.getFullYear()}`;
      dateEl.innerHTML =
        `<span class="live-clock-date-long">${longFmt}</span>` +
        `<span class="live-clock-date-short">${shortFmt}</span>`;
    }
  }
  tick();
  return setInterval(tick, 1000);
}

// ── User initials ────────────────────────────
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
