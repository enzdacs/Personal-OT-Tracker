// =============================================
// notifications.js — Push notifications & bell
// =============================================

let _notifUser      = null;
let _notifSettings  = null;
let _notifList      = [];    // { id, title, body, dateKey, timeStr, read }
let _notifTimers    = [];
let _dropdownOpen   = false;

// ── Public init ───────────────────────────────
function initNotifications(user, settings) {
  _notifUser     = user;
  _notifSettings = settings;
  loadNotifHistory();
  scheduleDailyNotifications();
  requestPushPermission();
  // Bell click wired via DOMContentLoaded below
}

// ── Push permission ───────────────────────────
async function requestPushPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

// ── Send a notification ───────────────────────
function sendNotification(title, body) {
  const now = getManilaDate();
  const notif = {
    id:      Date.now(),
    title,
    body,
    dateKey: getDateKey(now),          // "YYYY-MM-DD"
    timeStr: now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
    read:    false,
  };
  _notifList.unshift(notif);
  if (_notifList.length > 100) _notifList = _notifList.slice(0, 100);
  saveNotifHistory();
  updateBell();

  // OS-level notification
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, {
        body,
        icon:  'OTracker-logo.png',
        badge: 'OTracker-logo.png',
        tag:   title,
      });
    } catch(e) {}
  }

  // Re-render if dropdown is open
  if (_dropdownOpen) renderNotifDropdown();
}

// ── Persist ───────────────────────────────────
function saveNotifHistory() {
  try { localStorage.setItem('ot_notifications', JSON.stringify(_notifList)); } catch(e) {}
}
function loadNotifHistory() {
  try {
    const raw = localStorage.getItem('ot_notifications');
    if (raw) _notifList = JSON.parse(raw);
  } catch(e) { _notifList = []; }
  updateBell();
}

// ── Individual dismiss ────────────────────────
function dismissNotif(id) {
  _notifList = _notifList.filter(n => n.id !== id);
  saveNotifHistory();
  updateBell();
  renderNotifDropdown();
}

function clearAllNotifications() {
  _notifList = [];
  saveNotifHistory();
  updateBell();
  renderNotifDropdown();
}

// ── Bell dot ──────────────────────────────────
function updateBell() {
  const dot = document.getElementById('notif-dot');
  if (!dot) return;
  dot.classList.toggle('hidden', !_notifList.some(n => !n.read));
}

// ── Date label helpers ────────────────────────
function getNotifDateLabel(dateKey) {
  const now     = getManilaDate();
  const todayKey = getDateKey(now);
  const [y, mo, d] = dateKey.split('-').map(Number);
  const then      = new Date(y, mo - 1, d);
  const todayBase = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays  = Math.round((todayBase - then) / 86_400_000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  // Within the past 7 days → day name
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  if (diffDays < 7) return dayNames[then.getDay()];

  // Within the past year → MM/DD
  const [ty] = todayKey.split('-').map(Number);
  if (y === ty) return `${String(mo).padStart(2,'0')}/${String(d).padStart(2,'0')}`;

  // Older → MM/DD/YYYY
  return `${String(mo).padStart(2,'0')}/${String(d).padStart(2,'0')}/${y}`;
}

// ── Render dropdown ───────────────────────────
function renderNotifDropdown() {
  const container = document.getElementById('notif-dropdown');
  if (!container) return;

  const listEl = container.querySelector('.notif-dropdown-list');
  if (!listEl) return;

  if (_notifList.length === 0) {
    listEl.innerHTML = `<div class="notif-empty">No notifications yet.</div>`;
    return;
  }

  // Group by dateKey
  const groups = {};
  _notifList.forEach(n => {
    if (!groups[n.dateKey]) groups[n.dateKey] = [];
    groups[n.dateKey].push(n);
  });

  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  listEl.innerHTML = sortedDates.map(dateKey => {
    const label = getNotifDateLabel(dateKey);
    const items = groups[dateKey].map(n => `
      <div class="notif-item ${n.read ? 'notif-read' : 'notif-unread'}" id="notif-item-${n.id}">
        <div class="notif-item-icon">🔔</div>
        <div class="notif-item-content">
          <div class="notif-item-title">${n.title}</div>
          <div class="notif-item-body">${n.body}</div>
          <div class="notif-item-time">${n.timeStr}</div>
        </div>
        ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
        <button class="notif-dismiss-btn" onclick="dismissNotif(${n.id})" title="Dismiss">✕</button>
      </div>`).join('');
    return `<div class="notif-group-label">${label}</div>${items}`;
  }).join('');

  // Mark all as read (after render so unread dot shows briefly)
  setTimeout(() => {
    _notifList.forEach(n => n.read = true);
    saveNotifHistory();
    updateBell();
  }, 400);
}

// ── Toggle dropdown ───────────────────────────
function toggleNotifDropdown(e) {
  e.stopPropagation();
  const dropdown = document.getElementById('notif-dropdown');
  if (!dropdown) return;

  _dropdownOpen = !_dropdownOpen;
  dropdown.classList.toggle('hidden', !_dropdownOpen);

  if (_dropdownOpen) {
    renderNotifDropdown();
    // Close when clicking outside
    setTimeout(() => {
      document.addEventListener('click', closeNotifOnOutsideClick);
    }, 0);
  } else {
    document.removeEventListener('click', closeNotifOnOutsideClick);
  }
}

function closeNotifOnOutsideClick(e) {
  const dropdown = document.getElementById('notif-dropdown');
  const bell     = document.getElementById('notif-bell');
  if (dropdown && !dropdown.contains(e.target) && bell && !bell.contains(e.target)) {
    _dropdownOpen = false;
    dropdown.classList.add('hidden');
    document.removeEventListener('click', closeNotifOnOutsideClick);
  }
}

// ── Wire bell on DOMContentLoaded ────────────
document.addEventListener('DOMContentLoaded', () => {
  const bell = document.getElementById('notif-bell');
  if (bell) {
    bell.addEventListener('click', toggleNotifDropdown);
  }
});

// ═══════════════════════════════════════════════
// NOTIFICATION SCHEDULING
// ═══════════════════════════════════════════════

function scheduleDailyNotifications() {
  _notifTimers.forEach(t => clearTimeout(t));
  _notifTimers = [];

  const settings  = _notifSettings;
  if (!settings) return;

  const now     = getManilaDate();
  const today   = now.getDay();
  const workDays = settings.workDays || [1,2,3,4,5];

  if (!workDays.includes(today)) {
    scheduleOTReminder();
    return;
  }

  let workStart = settings.workStart || '08:00';
  let workEnd   = settings.workEnd   || '17:00';
  if (settings.multiSchedule && settings.perDaySchedule?.[today]) {
    workStart = settings.perDaySchedule[today].start;
    workEnd   = settings.perDaySchedule[today].end;
  }

  const ws = timeInputToHm(workStart);
  const we = timeInputToHm(workEnd);
  if (!ws || !we) return;

  const todayBase  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startMs    = todayBase.getTime() + (ws.h * 60 + ws.m) * 60_000;
  const endMs      = todayBase.getTime() + (we.h * 60 + we.m) * 60_000;

  // User-configurable: minutes before shift start warning
  const warnMins   = _notifSettings?.notifSettings?.shiftWarnMins ?? 5;
  const startWarnMs = warnMins > 0 ? startMs - warnMins * 60_000 : null;

  const scheduleAt = (targetMs, fn) => {
    if (targetMs === null) return;
    const delay = targetMs - Date.now();
    if (delay > 0) _notifTimers.push(setTimeout(fn, delay));
  };

  scheduleAt(startWarnMs, () => {
    sendNotification('⏰ Shift Starting Soon',
      `Your shift starts in ${warnMins} minute${warnMins !== 1 ? 's' : ''} at ${formatTime12(ws.h, ws.m)}. Get ready!`);
  });

  scheduleAt(startMs, () => {
    sendNotification('🟢 Shift Started',
      `Good morning! Your shift started at ${formatTime12(ws.h, ws.m)}.`);
  });

  scheduleAt(endMs, () => {
    sendNotification('🔴 Time to Clock Out',
      `Your shift ends at ${formatTime12(we.h, we.m)}. Don't forget to press Time Out!`);
    scheduleTimeoutReminders(endMs);
  });

  scheduleOTReminder();
}

async function scheduleTimeoutReminders(endMs) {
  const ns   = _notifSettings?.notifSettings || {};
  const freq = ns.timeoutRemindFreq || '60';
  if (freq === 'never') return;

  // Determine interval in minutes
  let intervalMins;
  if (freq === 'custom') {
    intervalMins = ns.timeoutCustomMins || 60;
  } else {
    intervalMins = parseInt(freq) || 60;
  }

  const intervalMs = intervalMins * 60_000;
  const maxHours   = 8; // stop after 8 hours
  const maxMs      = maxHours * 3_600_000;
  let offset       = intervalMs;

  while (offset <= maxMs) {
    const targetMs = endMs + offset;
    const delay    = targetMs - Date.now();
    if (delay > 0) {
      const hourCount = Math.round(offset / 3_600_000 * 10) / 10;
      _notifTimers.push(setTimeout(async () => {
        if (!_notifUser) return;
        try {
          const today = getDateKey();
          const doc   = await db.collection('users').doc(_notifUser.uid)
                                .collection('attendance').doc(today).get();
          if (doc.exists && doc.data().timeOutStamp) return;
          sendNotification('⚠️ Still Not Timed Out',
            `It's been ${hourCount >= 1 ? hourCount + 'h' : intervalMins + 'm'} since your shift ended. Remember to press Time Out!`);
        } catch(e) {}
      }, delay));
    }
    offset += intervalMs;
  }
}

function scheduleOTReminder() {
  const settings = _notifSettings;
  const ns       = settings?.notifSettings || {};
  const freq     = ns.otRemindFreq || 'daily';
  if (freq === 'never') return;

  const now = getManilaDate();
  const we  = timeInputToHm(settings?.workEnd || '17:00');
  if (!we) return;

  const todayBase  = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let reminderMs;
  if (freq === 'hourly') {
    // First reminder: 1 hour after work ends, then every hour (up to 4)
    const base = todayBase.getTime() + (we.h * 60 + we.m + 60) * 60_000;
    for (let i = 0; i < 4; i++) {
      const target = base + i * 3_600_000;
      const delay  = target - Date.now();
      if (delay <= 0) continue;
      _notifTimers.push(setTimeout(() => _fireOTReminder(), delay));
    }
    return;
  } else if (freq === 'weekly') {
    // Same time next Monday morning (or in 7 days)
    const sevenDays = todayBase.getTime() + 7 * 86_400_000 + 8 * 3_600_000;
    reminderMs = sevenDays;
  } else {
    // daily — 1 hour after work end
    reminderMs = todayBase.getTime() + (we.h * 60 + we.m + 60) * 60_000;
  }

  const delay = reminderMs - Date.now();
  if (delay <= 0) return;
  _notifTimers.push(setTimeout(() => _fireOTReminder(), delay));
}

async function _fireOTReminder() {
  if (!_notifUser) return;
  try {
    const snap    = await db.collection('users').doc(_notifUser.uid)
                           .collection('attendance').orderBy('date','desc').get();
    const records = snap.docs.map(d => d.data());
    const allOT   = records.reduce((s, r) => s + (r.otMinutes || 0), 0);
    const usedOT  = records.filter(r => r.otUsed).reduce((s, r) => s + (r.otMinutes || 0), 0);
    const remOT   = allOT - usedOT;
    if (remOT <= 0) return;

    const settings = _notifSettings;
    const we  = timeInputToHm(settings?.workEnd   || '17:00');
    const ws  = timeInputToHm(settings?.workStart || '08:00');
    const wh  = settings?.otToLeaveHours || ((we.h * 60 + we.m - ws.h * 60 - ws.m) / 60) || 8;
    const wm  = wh * 60;
    const hm  = wm / 2;
    const fd  = Math.floor(remOT / wm);
    const ad  = remOT - fd * wm;
    const hd  = Math.floor(ad / hm);
    const lh  = Math.round((ad - hd * hm) / 60 * 10) / 10;

    const parts = [];
    if (fd > 0) parts.push(`${fd} full day leave`);
    if (hd > 0) parts.push(`${hd} half day`);
    if (lh > 0) parts.push(`${lh}h of late`);

    if (parts.length > 0) {
      sendNotification('💡 OT Hours Available',
        `You have ${minutesToHm(remOT)} OT to use as: ${parts.join(', ')}.`);
    }
  } catch(e) {}
}
