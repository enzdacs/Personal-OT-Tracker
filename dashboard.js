// =============================================
// dashboard.js — Main attendance tracking logic
// =============================================

let currentUser   = null;
let userSettings  = null;
let allRecords    = [];
let editingId     = null;
let customWorkHours = {};

// Current record open in the unified modal
let modalRecordId = null;

document.addEventListener('DOMContentLoaded', () => {
  showLoader();
  requireAuth(async user => {
    currentUser  = user;
    userSettings = await getUserSettings(user.uid);
    updateSidebarUser();
    initSidebar();
    startLiveClock(
      document.getElementById('clock-time'),
      document.getElementById('clock-date')
    );
    await ensureTodayRecord();
    await loadRecords();
    startAbsenceWatcher();
    startWorkdayWatcher();
    initNotifications(user, userSettings);
    hideLoader();
    checkNewUser();
  });

  // Add-modal close buttons
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Unified record modal close
  document.getElementById('record-modal-close').addEventListener('click', () => closeModal('record-modal'));

  document.getElementById('btn-add-row').addEventListener('click', () => openModal('add-choice-modal'));
  document.getElementById('btn-save-record').addEventListener('click', saveRecord);
  document.getElementById('btn-filter').addEventListener('click', () => openModal('filter-modal'));
  document.getElementById('btn-export').addEventListener('click', openExportModal);
  document.getElementById('btn-apply-filter').addEventListener('click', applyFilters);
  document.getElementById('btn-do-export').addEventListener('click', doExport);
  document.getElementById('btn-confirm-use').addEventListener('click', confirmUseOT);
  document.getElementById('use-hours')?.addEventListener('input', () => { updateMinTimeOutHint(); validateUseForm(); });
  document.getElementById('use-timein')?.addEventListener('input', updateMinTimeOutHint);

  // Onboarding modal buttons
  document.getElementById('btn-ob-save').addEventListener('click', saveOnboarding);
  document.getElementById('btn-ob-later').addEventListener('click', () => {
    closeModal('onboarding-modal');
  });
  document.getElementById('btn-logout').addEventListener('click', confirmAndSignOut);

  // Auto-calc OT when timeout changes in add-modal
  document.getElementById('edit-timeout').addEventListener('input', recalcModalOT);
  document.getElementById('edit-date').addEventListener('change', recalcModalOT);
});

function updateSidebarUser() {
  const name     = userSettings.fullName || currentUser.email;
  const username = userSettings.username || name;
  const jobPosition = userSettings.jobPosition || userSettings.department || 'Employee';
  const company  = userSettings.companyName || '';
  document.getElementById('sidebar-username').textContent = name;
  document.getElementById('sidebar-dept').textContent     = jobPosition;
  document.getElementById('sidebar-avatar').textContent   = getInitials(name);
  // Update greeting card
  const gHi     = document.getElementById('greeting-hi');
  const gName   = document.getElementById('greeting-name');
  const gDept   = document.getElementById('greeting-dept');
  const gCompany = document.getElementById('greeting-company');
  if (gHi)   gHi.textContent   = 'Hi,';
  if (gName) gName.textContent = username;
  if (gDept) gDept.textContent = jobPosition;
  if (gCompany) {
    gCompany.textContent = company;
    gCompany.classList.toggle('hidden', !company);
  }
  updateRenderHoursDisplay();
  updateBadgesDisplay();
}

// ── Render Hours (interns) ───────────────────
function updateRenderHoursDisplay() {
  const wrap = document.getElementById('greeting-render-hours');
  if (!wrap) return;
  const isIntern = userSettings.userType === 'intern';
  const required = userSettings.requiredRenderHours;
  if (!isIntern || !required) { wrap.classList.add('hidden'); return; }

  const renderedMins = allRecords
    .filter(r => r.status === 'present' || r.status === 'ot-leave')
    .reduce((s, r) => s + (r.workMinutes || 0), 0);
  const renderedHours = Math.round((renderedMins / 60) * 10) / 10;
  const remaining = Math.max(0, Math.round((required - renderedHours) * 10) / 10);

  wrap.classList.remove('hidden');
  document.getElementById('greeting-render-hours-text').textContent =
    `${renderedHours} of ${required} hrs rendered`;
  document.getElementById('greeting-render-hours-sub').textContent =
    `${remaining} hrs remaining`;
}

// ── Badges & Streaks (welcome card summary) ──
function updateBadgesDisplay() {
  const wrap = document.getElementById('greeting-badges');
  if (!wrap || allRecords.length === 0) return;

  const result = computeBadges(allRecords, userSettings);
  wrap.classList.remove('hidden');
  document.getElementById('greeting-streak-text').textContent =
    result.current > 0 ? `${result.current}-day streak` : 'No active streak';

  const earnedBadges = BADGE_DEFS.filter(b => result.earned[b.id]);
  const iconsEl = document.getElementById('greeting-badges-icons');
  if (iconsEl) {
    iconsEl.innerHTML = earnedBadges.slice(0, 5).map(b => `
      <span class="greeting-badge-chip" style="--badge-color:${b.color};--badge-bg:${b.color}22" title="${b.name}">
        <i data-lucide="${b.icon}"></i>
      </span>`).join('');
    if (window.lucide) lucide.createIcons();
  }
}

// ── New-user onboarding ──────────────────────
function checkNewUser() {
  if (userSettings.isNewUser) {
    openModal('onboarding-modal');
  }
}

async function saveOnboarding() {
  const start = document.getElementById('ob-work-start').value;
  const end   = document.getElementById('ob-work-end').value;
  const grace = parseInt(document.getElementById('ob-grace').value) || 0;
  const days  = [];
  document.querySelectorAll('#onboarding-modal .day-check:checked').forEach(cb => days.push(parseInt(cb.value)));

  if (!start || !end) { showToast('Please set your work start and end times.', 'error'); return; }
  if (days.length === 0) { showToast('Please select at least one working day.', 'error'); return; }

  const btn = document.getElementById('btn-ob-save');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    await db.collection('users').doc(currentUser.uid)
            .collection('config').doc('settings')
            .set({ workStart: start, workEnd: end, gracePeriod: grace, workDays: days, isNewUser: false }, { merge: true });
    clearSettingsCache();
    userSettings = await getUserSettings(currentUser.uid);
    showToast('Schedule saved ✓', 'success');
    closeModal('onboarding-modal');
    await ensureTodayRecord();
    await loadRecords();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Schedule';
  }
}
function getEffectiveWorkHours(dateKey) {
  if (customWorkHours[dateKey]) return customWorkHours[dateKey];
  return { workStart: userSettings.workStart || '08:00', workEnd: userSettings.workEnd || '17:00' };
}

function formatWorkRange(workStart, workEnd) {
  const s = timeInputToHm(workStart);
  const e = timeInputToHm(workEnd);
  if (!s || !e) return '—';
  return `${formatTime12(s.h, s.m)}–${formatTime12(e.h, e.m)}`;
}

// ── Ensure today has a record ────────────────
async function ensureTodayRecord() {
  const today  = getDateKey();
  const dayIdx = getDayIndex(today);
  if (!userSettings.workDays.includes(dayIdx)) return;

  const ref  = db.collection('users').doc(currentUser.uid).collection('attendance').doc(today);
  const snap = await ref.get();
  if (!snap.exists) {
    const s = timeInputToHm(userSettings.workStart || '08:00');
    await ref.set({
      date: today, timeOutStamp: null, timeOutDisplay: null,
      timeInDisplay: s ? formatTime12(s.h, s.m) : null,
      workMinutes: null, otMinutes: null, status: 'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(), note: '',
    });
  }
}

// ── Load all records ─────────────────────────
async function loadRecords() {
  const snap = await db.collection('users').doc(currentUser.uid)
                       .collection('attendance').orderBy('date', 'desc').get();
  allRecords = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  allRecords = applyEffectiveMinutes(allRecords, userSettings);
  allRecords.forEach(r => {
    if (r.customWorkStart || r.customWorkEnd) {
      customWorkHours[r.id] = {
        workStart: r.customWorkStart || userSettings.workStart,
        workEnd:   r.customWorkEnd   || userSettings.workEnd,
      };
    }
  });
  renderTable();
  renderStats();
  updateRenderHoursDisplay();
  updateBadgesDisplay();
}

// ── Absence watcher: mark absent at 11 PM if no time out ──
function startAbsenceWatcher() {
  setInterval(async () => {
    const today = getDateKey();
    const rec   = allRecords.find(r => r.id === today);
    if (!rec || rec.status !== 'pending' || rec.timeOutStamp) return;
    const now = getManilaDate();
    if (now.getHours() >= 23) {
      try {
        await db.collection('users').doc(currentUser.uid)
                .collection('attendance').doc(today)
                .update({ status: 'absent', workMinutes: 0, otMinutes: 0 });
        await loadRecords();
      } catch(e) {}
    }
  }, 60_000);
}

// ── Workday watcher: auto-create record at work start time ──
function startWorkdayWatcher() {
  let lastCheckedDate = null;
  setInterval(async () => {
    const now    = getManilaDate();
    const today  = getDateKey();
    const dayIdx = getDayIndex(today);

    // Only on configured work days
    if (!userSettings.workDays.includes(dayIdx)) return;

    // Don't create a new record if we already checked this minute
    const minuteKey = `${today}-${now.getHours()}-${now.getMinutes()}`;
    if (lastCheckedDate === minuteKey) return;
    lastCheckedDate = minuteKey;

    // Check if current time matches work start time (within the same minute)
    const { workStart } = getEffectiveWorkHours(today);
    const ws = timeInputToHm(workStart);
    if (!ws) return;
    if (now.getHours() !== ws.h || now.getMinutes() !== ws.m) return;

    // Check if today's record already exists
    const existing = allRecords.find(r => r.id === today);
    if (existing) return;

    // Create it
    try {
      await db.collection('users').doc(currentUser.uid).collection('attendance').doc(today).set({
        date: today, timeOutStamp: null, timeOutDisplay: null,
        timeInDisplay: formatTime12(ws.h, ws.m),
        workMinutes: null, otMinutes: null, status: 'pending',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(), note: '',
      });
      await loadRecords();
    } catch(e) {}
  }, 10_000); // check every 10 seconds (precise enough for minute-level detection)
}
function formatDateShort(dateKey) {
  const [y, mo, d] = dateKey.split('-');
  return `${mo}/${d}/${y}`;
}

function formatDateLong(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  return date.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ── Render Table (all records, no pagination) ──
function renderTable() {
  const tbody = document.getElementById('records-tbody');
  const today = getDateKey();
  if (!tbody) return;

  const filteredRecords = getFilteredTableRecords();
  if (filteredRecords.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5">
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>${Object.values(activeFilters).some(v=>v) ? 'No records match your filters.' : 'No records yet. Your attendance will appear here daily.'}</p>
      </div></td></tr>`;
    updateRecordCount(0);
    return;
  }

  tbody.innerHTML = filteredRecords.map(rec => {
    const isToday     = rec.id === today;
    const isAbsent    = rec.status === 'absent';
    const isHoliday   = rec.status === 'holiday';
    const isOTLeave   = rec.status === 'ot-leave'; // full-day leave only — half day/undertime stay 'present'
    const hasUsage    = !!rec.otUsageType;
    const notTimedOut = !rec.timeOutStamp && !isAbsent && !isHoliday && !isOTLeave;

    let rowClass = '';
    if (isAbsent)                    rowClass = 'row-absent';
    else if (isHoliday)              rowClass = 'row-holiday';
    else if (isOTLeave || hasUsage)  rowClass = 'row-leave'; // any leave (SL/VL/BL) or offset used
    else if (isToday && notTimedOut) rowClass = 'row-today';
    else if (rec.otMinutes > 0)      rowClass = 'row-ot';

    // Time In cell — only meaningful for days actually worked
    const timeInCell = (isOTLeave || isAbsent || isHoliday || (notTimedOut && !isToday))
      ? '—'
      : rec.timeInDisplay
        ? `<span style="font-weight:600">${rec.timeInDisplay}</span>`
        : '—';

    // Time Out (OT) cell — full-day leave shows "N/A" (no clock in/out that day); everything
    // else shows the actual logged time, with any OT appended in the same font color.
    let timeOutCell;
    if (isOTLeave) {
      timeOutCell = `<span class="badge badge-gray">N/A</span>`;
    } else if (isHoliday) {
      timeOutCell = `<span class="badge badge-holiday">HOL</span>`;
    } else if (isAbsent) {
      timeOutCell = `<span class="badge badge-danger">ABS</span>`;
    } else if (rec.timeOutDisplay) {
      const otSuffix = rec.otMinutes > 0 ? ` <span style="font-weight:600">(${minutesToHm(rec.otMinutes)})</span>` : '';
      timeOutCell = `<span style="font-weight:600">${rec.timeOutDisplay}</span>${otSuffix}`;
    } else if (notTimedOut && isToday) {
      timeOutCell = `<span class="badge badge-warning">Pending</span>`;
    } else if (notTimedOut && !isToday) {
      timeOutCell = `<span class="badge badge-danger">ABS</span>`;
    } else {
      timeOutCell = '—';
    }

    // Work Hours cell
    const { workStart, workEnd } = getEffectiveWorkHours(rec.id);
    const workHoursCell = `
      <div style="line-height:1.3;text-align:center">
        <div class="work-hrs-range">${formatWorkRange(workStart, workEnd)}</div>
        ${rec.workMinutes != null ? `<div style="font-size:.7rem;color:var(--text-light)">${minutesToHm(rec.workMinutes)} worked</div>` : ''}
      </div>`;

    // OT USE cell — plain indicator now (no button). Interacting with a usage (editing or
    // undoing it) happens via the row's View/Edit modal, not from the table directly.
    // A date whose OT was used by an offset shows USED + the date it was used on.
    const usageBadge = hasUsage
      ? `<span class="badge badge-ot-leave" title="${otUsageFullLabel(rec.otUsageType)}">${otUsageShortLabel(rec.otUsageType)}</span>`
      : '';
    const usedBadge = rec.otUsedOn
      ? `<span class="badge" style="background:var(--success);color:#fff;font-weight:700" title="OT used on ${formatDateShort(rec.otUsedOn)}">USED</span>
         <span style="font-size:.68rem;color:var(--text-light)">${formatDateShort(rec.otUsedOn)}</span>`
      : '';
    const otUseCell = (usageBadge || usedBadge)
      ? `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;line-height:1.2">${usageBadge}${usedBadge}</div>`
      : `<span class="badge badge-gray" style="min-width:54px;justify-content:center">N/A</span>`;

    return `<tr class="${rowClass} row-clickable" onclick="viewRecord('${rec.id}')">
      <td>
        <div style="font-weight:600;font-size:.82rem">${formatDateShort(rec.date)}</div>
        <div style="font-size:.7rem;color:var(--text-light)">${dayName(rec.date)}</div>
      </td>
      <td>${timeInCell}</td>
      <td>${timeOutCell}</td>
      <td>${workHoursCell}</td>
      <td>${otUseCell}</td>
    </tr>`;
  }).join('');

  updateRecordCount(filteredRecords.length);
}

function updateRecordCount(total) {
  const bar = document.getElementById('pagination-bar');
  if (!bar) return;
  if (total === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const filtered = Object.values(activeFilters).some(v => v);
  bar.innerHTML = `<div class="pagination-info">
    <span>${total} record${total !== 1 ? 's' : ''}${filtered ? ' (filtered)' : ''}</span>
  </div>`;
}

// ── Stats ────────────────────────────────────
function renderStats() {
  const workHours = getWorkdayHours();
  const pool      = getOTPool(allRecords);
  const usedOT    = pool.used;
  const remOT     = pool.remaining;
  const absences  = allRecords.filter(r => r.status === 'absent').length;

  // Leave days earned = remaining OT ÷ work hours per day
  const leaveDays = workHours > 0 ? (remOT / 60 / workHours) : 0;
  const wholeDays = Math.floor(leaveDays);
  const remHours  = Math.round((leaveDays - wholeDays) * workHours * 10) / 10;
  let leaveDisplay = '—';
  if (workHours > 0) {
    leaveDisplay = wholeDays > 0
      ? `${wholeDays}d${remHours > 0 ? ` ${remHours}h` : ''}`
      : remOT > 0 ? `${(remOT/60).toFixed(1)}h` : '0d';
  }

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stat-leave-days', leaveDisplay);
  set('stat-ot-used',    minutesToHm(usedOT));
  set('stat-ot-rem',     minutesToHm(remOT));
  set('stat-absences',   absences);
  renderLeaveBalance();
}

// Remaining leaves for the current year, shown above the Attendance Records table
function renderLeaveBalance() {
  const el = document.getElementById('leave-balance-strip');
  if (!el) return;
  const year = getDateKey().slice(0, 4);
  const bal  = getLeaveBalance(allRecords, userSettings, year);
  el.innerHTML = `<span style="font-weight:600;color:var(--text)">Leaves left (${year}):</span>` +
    LEAVE_CODES.map(c => `<span class="badge ${bal[c].remaining > 0 ? 'badge-ot-leave' : 'badge-gray'}" title="${otUsageFullLabel(c)}">${c} ${bal[c].remaining}/${bal[c].total}</span>`).join('');
}

function getWorkdayHours() {
  const s = timeInputToHm(userSettings.workStart || '08:00');
  const e = timeInputToHm(userSettings.workEnd   || '17:00');
  if (!s || !e) return 8;
  const rawMins = (e.h * 60 + e.m) - (s.h * 60 + s.m);
  return Math.max(0, rawMins - getBreakMinutes()) / 60;
}

// Breaktime Hours (from Schedule settings) converted to minutes. Old users with no
// breakHours saved yet default to 0, so their existing work-hour math is unaffected.
function getBreakMinutes() {
  return Math.max(0, Math.round((userSettings.breakHours || 0) * 60));
}

// Apply the company's OT counting rule to raw overtime minutes
function applyOTRule(rawOTMins) {
  return applyOTCountingRule(rawOTMins, userSettings.otCountingRule);
}

// ── USE LEAVE/OFFSET Modal ───────────────────

// Offset dates picked in the Use modal / Edit modal (each id is a record date, yyyy-mm-dd).
// editOffsetDates === null means "untouched" — the record keeps its current offset dates.
let useOffsetDates   = [];
let editOffsetDates  = null;
let offsetPickerMode = 'use';

function getRemainingOTMinutes() {
  return getOTPool(allRecords).remaining;
}

function minutesToHHMM(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Total OT minutes of the given record dates
function getOffsetMins(dates) {
  return (dates || []).reduce((sum, id) => {
    const r = allRecords.find(x => x.id === id);
    return sum + (r ? (r.otMinutes || 0) : 0);
  }, 0);
}

function getPendingUseDeductMins() {
  const type = document.getElementById('use-type')?.value;
  return type === 'OS' ? getOffsetMins(useOffsetDates) : 0; // leaves never deduct OT
}

function updateUseLeaveInfo() {
  const el = document.getElementById('use-leave-info');
  if (!el) return;
  const type = document.getElementById('use-type')?.value;
  if (!isLeaveUsage(type)) { el.textContent = ''; return; }
  const year = (document.getElementById('use-leave-date')?.value || getDateKey()).slice(0, 4);
  const b = getLeaveBalance(allRecords, userSettings, year)[type];
  let text = `${b.remaining} of ${b.total} left for ${year}`;
  if (type === 'BL' && userSettings.birthDate) text += ` · Birthday: ${formatDateShort(userSettings.birthDate).slice(0, 5)}`;
  el.textContent = text;
}

// Live-checks the pending Leave/Offset; disables Confirm + shows a warning if it can't be filed
function validateUseForm() {
  const type = document.getElementById('use-type')?.value;
  const date = document.getElementById('use-leave-date')?.value;
  const warning = document.getElementById('use-insufficient-warning');
  const warningText = document.getElementById('use-insufficient-warning-text');
  const btn = document.getElementById('btn-confirm-use');
  let msg = '';

  if (isLeaveUsage(type)) {
    const year = (date || getDateKey()).slice(0, 4);
    const b = getLeaveBalance(allRecords, userSettings, year)[type];
    const existing = allRecords.find(r => r.id === date);
    const sameLeaveAlready = existing && existing.otUsageType === type; // re-filing doesn't use a 2nd credit
    if (b.remaining <= 0 && !sameLeaveAlready) {
      msg = `No ${otUsageFullLabel(type)} credits left for ${year}.${b.total === 0 ? ' Set your leave credits in the Schedule tab.' : ''}`;
    }
  } else {
    const remOT  = getRemainingOTMinutes();
    const deduct = getPendingUseDeductMins();
    if (deduct > 0 && deduct > remOT) msg = `You need ${minutesToHm(deduct)} but only have ${minutesToHm(remOT)} of OT available.`;
  }

  if (warning) warning.classList.toggle('hidden', !msg);
  if (warningText && msg) warningText.textContent = msg;
  if (btn) btn.disabled = !!msg;
  updateUseLeaveInfo();
  return !msg;
}

function openUseModal() {
  if (userSettings.userType === 'intern') {
    showToast('OT usage is disabled for interns. Your OT hours are still being counted.', 'default');
    return;
  }

  document.getElementById('use-modal-avail').textContent = minutesToHm(getRemainingOTMinutes());
  document.getElementById('use-leave-date').value        = getDateKey();
  document.getElementById('use-type').value              = 'SL';
  document.getElementById('use-timein').value            = userSettings.workStart || '08:00';
  document.getElementById('use-hours').value             = '';
  document.getElementById('use-note').value              = '';
  useOffsetDates = [];
  handleUseTypeChange();
  openModal('use-modal');
}

function refreshUseOffsetSummary() {
  const el = document.getElementById('use-offset-summary');
  const mins = getOffsetMins(useOffsetDates);
  const n = useOffsetDates.length;
  if (el) el.textContent = n ? `${n} date${n !== 1 ? 's' : ''} selected — total ${minutesToHHMM(mins)}` : 'No dates selected.';
  const hoursEl = document.getElementById('use-hours');
  if (hoursEl) hoursEl.value = n ? (mins / 60).toFixed(4) : '';
}

function handleUseTypeChange() {
  const type = document.getElementById('use-type')?.value;
  const isOffset = type === 'OS';
  const og = document.getElementById('use-offset-group');
  const timeInGroup = document.getElementById('use-timein-group');
  if (og) og.classList.toggle('hidden', !isOffset);
  if (timeInGroup) timeInGroup.style.display = isOffset ? 'block' : 'none';
  if (isOffset) refreshUseOffsetSummary();
  updateMinTimeOutHint();
  validateUseForm();
}

// Offset only. Live hint: a full-day offset is logged as a leave day; otherwise show the minimum Time Out.
// Informational only — the actual warning happens later when the real Time Out for that day is logged.
function updateMinTimeOutHint() {
  const type = document.getElementById('use-type')?.value;
  const hintEl = document.getElementById('use-min-timeout-hint');
  if (!hintEl) return;
  const declaredMins = getOffsetMins(useOffsetDates);
  if (type !== 'OS' || declaredMins <= 0) { hintEl.classList.add('hidden'); return; }

  const wh = getWorkdayHours();
  if (declaredMins >= Math.round(wh * 60)) {
    hintEl.classList.remove('hidden');
    hintEl.textContent = 'This covers a full workday, so it will be logged as a leave day (no Time In needed).';
    return;
  }
  const s = timeInputToHm(document.getElementById('use-timein')?.value);
  if (!s) { hintEl.classList.add('hidden'); return; }
  const expectedWorkMins = Math.max(0, Math.round(wh * 60) - declaredMins);
  const minMins = (s.h * 60 + s.m) + getBreakMinutes() + expectedWorkMins;
  hintEl.classList.remove('hidden');
  hintEl.textContent = `Based on this, your minimum Time Out that day is ${minutesToClockLabel(minMins)}.`;
}

// ── Select Offset Dates picker ────────────────
// Lists every date that still has unused OT hours. Used by both the Use modal and the Edit modal.
function openOffsetPicker(mode) {
  offsetPickerMode = mode;
  let usageDate, selected;
  if (mode === 'edit') {
    const rec = allRecords.find(r => r.id === modalRecordId);
    usageDate = modalRecordId;
    selected  = editOffsetDates !== null ? editOffsetDates : ((rec && rec.otOffsetDates) || []);
  } else {
    usageDate = document.getElementById('use-leave-date')?.value;
    if (!usageDate) { showToast('Please select the date to apply this to first.', 'error'); return; }
    selected = useOffsetDates;
  }

  const candidates = allRecords
    .filter(r => (r.otMinutes || 0) > 0 && r.id !== usageDate && (!r.otUsedOn || r.otUsedOn === usageDate))
    .slice().sort((a, b) => a.date.localeCompare(b.date));

  const list = document.getElementById('offset-dates-list');
  list.innerHTML = candidates.length
    ? candidates.map(r => `
        <label style="display:flex;align-items:center;gap:.6rem;padding:.55rem .75rem;border-bottom:1px solid var(--border);cursor:pointer;font-size:.86rem">
          <input type="checkbox" class="offset-date-check" value="${r.id}" data-mins="${r.otMinutes}" ${selected.includes(r.id) ? 'checked' : ''} onchange="updateOffsetTotal()"/>
          <span>${formatDateShort(r.date)} (${minutesToHHMM(r.otMinutes)})</span>
        </label>`).join('')
    : `<div style="padding:1rem;text-align:center;font-size:.82rem;color:var(--text-light)">No dates with available OT hours.</div>`;
  updateOffsetTotal();
  openModal('offset-dates-modal');
}

function updateOffsetTotal() {
  let mins = 0;
  document.querySelectorAll('.offset-date-check:checked').forEach(cb => { mins += parseInt(cb.dataset.mins) || 0; });
  const el = document.getElementById('offset-dates-total');
  if (el) el.textContent = minutesToHHMM(mins);
}

function applyOffsetSelection() {
  const dates = [...document.querySelectorAll('.offset-date-check:checked')].map(cb => cb.value).sort();
  closeModal('offset-dates-modal');
  document.body.style.overflow = 'hidden'; // the Use / Record modal underneath is still open
  if (offsetPickerMode === 'edit') {
    editOffsetDates = dates;
    handleEditUsageTypeChange();
  } else {
    useOffsetDates = dates;
    refreshUseOffsetSummary();
    updateMinTimeOutHint();
    validateUseForm();
  }
}

// Keeps the "USED" marker on the source OT dates in sync with the offset record that consumes them
async function syncOffsetSources(usageDate, oldDates, newDates) {
  oldDates = oldDates || []; newDates = newDates || [];
  const col = db.collection('users').doc(currentUser.uid).collection('attendance');
  const exists = id => allRecords.some(r => r.id === id);
  const batch = db.batch();
  let ops = 0;
  newDates.forEach(id => { if (exists(id)) { batch.update(col.doc(id), { otUsedOn: usageDate }); ops++; } });
  oldDates.filter(id => !newDates.includes(id)).forEach(id => {
    if (exists(id)) { batch.update(col.doc(id), { otUsedOn: firebase.firestore.FieldValue.delete() }); ops++; }
  });
  if (ops) await batch.commit();
}

async function confirmUseOT() {
  const type      = document.getElementById('use-type').value;
  const leaveDate = document.getElementById('use-leave-date').value;
  const note      = document.getElementById('use-note').value.trim();
  const tin       = document.getElementById('use-timein')?.value || userSettings.workStart || '08:00';
  const wh        = getWorkdayHours();
  const isLeave   = isLeaveUsage(type);

  if (!leaveDate) { showToast('Please select a date.', 'error'); return; }

  let deductMins = 0;
  let usageLabel = type;      // SL / VL / BL
  let offsetDates = [];
  if (!isLeave) {
    usageLabel  = 'LATE-OT';  // Offset keeps its stored code so older records keep working
    offsetDates = useOffsetDates.slice();
    if (offsetDates.length === 0) { showToast('Please select the offset dates.', 'error'); return; }
    if (offsetDates.includes(leaveDate)) { showToast("The date you're applying this to can't also be an offset date. Re-select the dates.", 'error'); return; }
    deductMins = getOffsetMins(offsetDates);
  }

  if (!validateUseForm()) {
    showToast(document.getElementById('use-insufficient-warning-text').textContent, 'error');
    return;
  }

  // Warn before silently overwriting an existing day's record
  const leaveRef = db.collection('users').doc(currentUser.uid).collection('attendance').doc(leaveDate);
  const leaveSnap = await leaveRef.get();
  if (leaveSnap.exists) {
    const proceed = await showConfirmDialog({
      title: 'Record Already Exists',
      message: `A record for <strong>${formatDateLong(leaveDate)}</strong> already exists. Applying this will modify it. Continue?`,
      confirmLabel: 'Continue',
      danger: true,
    });
    if (!proceed) return;
  }
  const prevDates = (leaveSnap.exists && leaveSnap.data().otOffsetDates) || [];

  const btn = document.getElementById('btn-confirm-use');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    // Leaves (and an offset that covers a whole workday) are logged as a leave day — no clock in/out.
    const fullDay = isLeave || deductMins >= Math.round(wh * 60);
    const offsetField = leaveSnap.exists
      ? { otOffsetDates: isLeave ? firebase.firestore.FieldValue.delete() : offsetDates }
      : (isLeave ? {} : { otOffsetDates: offsetDates });

    if (fullDay) {
      const leaveData = {
        date: leaveDate, status: 'ot-leave',
        otUsageType: usageLabel, otUsageMins: deductMins, otUsageNote: note,
        timeInDisplay: null, timeOutStamp: null, timeOutDisplay: null,
        workMinutes: Math.round(wh * 60), otMinutes: 0,
        ...offsetField,
      };
      if (!leaveSnap.exists) {
        await leaveRef.set({ ...leaveData, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      } else {
        await leaveRef.update(leaveData);
      }
    } else {
      // Partial-day offset — the person does work that day. Time In defaults to schedule
      // start (editable); Work Hours are computed from their actual logged Time Out once entered.
      const inParsed = timeInputToHm(tin);
      const timeInDisplay = inParsed ? formatTime12(inParsed.h, inParsed.m) : null;
      const leaveData = {
        date: leaveDate, status: 'present',
        otUsageType: usageLabel, otUsageMins: deductMins, otUsageNote: note,
        timeInDisplay,
        ...offsetField,
      };
      if (!leaveSnap.exists) {
        await leaveRef.set({
          ...leaveData,
          timeOutStamp: null, timeOutDisplay: null, workMinutes: null, otMinutes: null,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        // Preserve any real clock data already logged for that date — only set Time In if
        // it wasn't already recorded, so we don't overwrite an actual clock-in.
        if (!leaveSnap.data().timeInDisplay) await leaveRef.update(leaveData);
        else await leaveRef.update({ otUsageType: usageLabel, otUsageMins: deductMins, otUsageNote: note, ...offsetField });
      }
    }

    await syncOffsetSources(leaveDate, prevDates, offsetDates);

    showToast(`${otUsageShortLabel(usageLabel)} logged on ${formatDateShort(leaveDate)} ✓`, 'success');
    closeModal('use-modal');
    await loadRecords();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Confirm Use';
  }
}

// ── Undo Use — confirm prompt ─────────────────
// Operates on the usage record itself (OT is pooled — there's no separate "source" record anymore)
function undoUse(id) {
  const rec = allRecords.find(r => r.id === id);
  if (!rec) return;
  modalRecordId = id;
  openModal('record-modal');
  setModalMode('confirm-undo');
}

function renderConfirmUndoMode(rec, titleEl, bodyEl, footerEl) {
  titleEl.textContent = 'Undo Leave/Offset';
  const label = otUsageShortLabel(rec.otUsageType);
  bodyEl.innerHTML = `
    <p style="font-size:.88rem;color:var(--text)">
      Undo this ${label} usage for <strong>${formatDateLong(rec.date)}</strong>?
      ${rec.status === 'ot-leave'
        ? ' This record will be removed since no work was logged that day.'
        : ' The day keeps its logged attendance — only the usage will be removed.'}
      ${isLeaveUsage(rec.otUsageType) ? 'Your leave credit will be restored.' : 'Your OT hours will be restored.'}
    </p>`;
  footerEl.innerHTML = `
    <button class="btn btn-ghost" onclick="setModalMode('view')">No, Keep It</button>
    <button class="btn btn-danger" onclick="executeUndoUse('${rec.id}')">Yes, Undo</button>`;
}

async function executeUndoUse(id) {
  const rec = allRecords.find(r => r.id === id);
  if (!rec) return;
  try {
    const ref = db.collection('users').doc(currentUser.uid).collection('attendance').doc(id);
    if (rec.status === 'ot-leave') {
      // Leave-day placeholder — nothing was actually worked, so remove it entirely
      await ref.delete();
      showToast('Usage undone — leave day removed.', 'default');
    } else {
      // Partial-day offset — keep the real attendance logged that day, just drop the usage
      await ref.update({
        otUsageType: firebase.firestore.FieldValue.delete(),
        otUsageMins: firebase.firestore.FieldValue.delete(),
        otUsageNote: firebase.firestore.FieldValue.delete(),
        otUsageDate: firebase.firestore.FieldValue.delete(),
        otSourceId:  firebase.firestore.FieldValue.delete(),
        otOffsetDates: firebase.firestore.FieldValue.delete(),
      });
      showToast('Usage undone.', 'default');
    }
    await syncOffsetSources(id, rec.otOffsetDates || [], []); // frees the dates that were marked USED
    closeModal('record-modal');
    await loadRecords();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

let activeFilters = {};

function applyFilters() {
  activeFilters = {
    status:  document.getElementById('f-status').value,
    dateFrom: document.getElementById('f-date-from').value,
    dateTo:   document.getElementById('f-date-to').value,
    otUse:    document.getElementById('f-ot-use').value,
  };
  closeModal('filter-modal');
  renderTable();
  updateFilterBanner();
}

function clearFilters() {
  activeFilters = {};
  document.getElementById('f-status').value    = '';
  document.getElementById('f-date-from').value = '';
  document.getElementById('f-date-to').value   = '';
  document.getElementById('f-ot-use').value    = '';
  renderTable();
  updateFilterBanner();
}

function updateFilterBanner() {
  const banner = document.getElementById('filter-banner');
  const text   = document.getElementById('filter-banner-text');
  const hasFilter = Object.values(activeFilters).some(v => v);
  if (banner) banner.classList.toggle('hidden', !hasFilter);
  if (text && hasFilter) {
    const parts = [];
    if (activeFilters.status)   parts.push(`Status: ${activeFilters.status}`);
    if (activeFilters.dateFrom) parts.push(`From: ${activeFilters.dateFrom}`);
    if (activeFilters.dateTo)   parts.push(`To: ${activeFilters.dateTo}`);
    if (activeFilters.otUse)    parts.push(`OT: ${activeFilters.otUse}`);
    text.textContent = parts.join(' · ');
  }
}

function getFilteredTableRecords() {
  return allRecords.filter(r => {
    if (activeFilters.status   && r.status !== activeFilters.status) return false;
    if (activeFilters.dateFrom && r.date < activeFilters.dateFrom)   return false;
    if (activeFilters.dateTo   && r.date > activeFilters.dateTo)     return false;
    const otIsUsed = isOTFundedUsage(r.otUsageType) || !!r.otUsedOn; // leaves (SL/VL/BL) don't count as OT used
    if (activeFilters.otUse === 'used'    && !otIsUsed)              return false;
    if (activeFilters.otUse === 'unused'  && otIsUsed)               return false;
    if (activeFilters.otUse === 'has-ot'  && !(r.otMinutes > 0))     return false;
    return true;
  });
}

// ── Export ────────────────────────────────────
const exportMonthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function openExportModal() {
  const now = getManilaDate();
  document.getElementById('export-range-type').value = 'month';
  document.getElementById('export-month').value  = now.getMonth() + 1;
  document.getElementById('export-year').value   = now.getFullYear();
  document.getElementById('export-from-month').value = now.getMonth() + 1;
  document.getElementById('export-from-year').value  = now.getFullYear();
  document.getElementById('export-to-month').value   = now.getMonth() + 1;
  document.getElementById('export-to-year').value    = now.getFullYear();
  document.getElementById('export-year-single').value = now.getFullYear();
  document.getElementById('export-from-year-only').value = now.getFullYear();
  document.getElementById('export-to-year-only').value   = now.getFullYear();
  handleExportRangeChange();
  openModal('export-modal');
}

function handleExportRangeChange() {
  const type = document.getElementById('export-range-type').value;
  document.getElementById('export-group-month').classList.toggle('hidden', type !== 'month');
  document.getElementById('export-group-months').classList.toggle('hidden', type !== 'months');
  document.getElementById('export-group-year').classList.toggle('hidden', type !== 'year');
  document.getElementById('export-group-years').classList.toggle('hidden', type !== 'years');
}

// Resolves the modal's inputs into a filtered record list + display/file labels
function resolveExportSelection() {
  const type = document.getElementById('export-range-type').value;

  if (type === 'month') {
    const month = parseInt(document.getElementById('export-month').value);
    const year  = parseInt(document.getElementById('export-year').value);
    const prefix = `${year}-${String(month).padStart(2,'0')}`;
    return {
      recs: allRecords.filter(r => r.date.startsWith(prefix)),
      titleLabel: `${exportMonthNames[month-1]} ${year}`,
      fileLabel:  `${exportMonthNames[month-1]}_${year}`,
    };
  }

  if (type === 'months') {
    const fm = parseInt(document.getElementById('export-from-month').value);
    const fy = parseInt(document.getElementById('export-from-year').value);
    const tm = parseInt(document.getElementById('export-to-month').value);
    const ty = parseInt(document.getElementById('export-to-year').value);
    const fromYm = `${fy}-${String(fm).padStart(2,'0')}`;
    const toYm   = `${ty}-${String(tm).padStart(2,'0')}`;
    if (fromYm > toYm) { showToast('"From" must be before "To".', 'error'); return null; }
    return {
      recs: allRecords.filter(r => { const ym = r.date.slice(0,7); return ym >= fromYm && ym <= toYm; }),
      titleLabel: `${exportMonthNames[fm-1]} ${fy} – ${exportMonthNames[tm-1]} ${ty}`,
      fileLabel:  `${exportMonthNames[fm-1]}${fy}-${exportMonthNames[tm-1]}${ty}`,
    };
  }

  if (type === 'year') {
    const year = parseInt(document.getElementById('export-year-single').value);
    return {
      recs: allRecords.filter(r => r.date.startsWith(`${year}`)),
      titleLabel: `${year}`,
      fileLabel:  `${year}`,
    };
  }

  // type === 'years'
  const fy = parseInt(document.getElementById('export-from-year-only').value);
  const ty = parseInt(document.getElementById('export-to-year-only').value);
  if (fy > ty) { showToast('"From Year" must be before "To Year".', 'error'); return null; }
  return {
    recs: allRecords.filter(r => { const y = parseInt(r.date.slice(0,4)); return y >= fy && y <= ty; }),
    titleLabel: `${fy} – ${ty}`,
    fileLabel:  `${fy}-${ty}`,
  };
}

async function doExport() {
  const selection = resolveExportSelection();
  if (!selection) return;
  const { recs, titleLabel, fileLabel } = selection;
  const fmt = document.querySelector('input[name="export-fmt"]:checked')?.value || 'csv';

  const statusLabel = r => {
    if (r.status === 'ot-leave')     return r.otUsageType || 'OT-L';
    if (r.status === 'absent')       return 'ABS';
    if (r.status === 'holiday')      return 'HOL';
    if (r.otUsageType === 'FL-OT')   return 'FL-OT';
    if (r.otUsageType === 'HD-OT')   return 'HD-OT';
    if (r.otUsageType === 'LATE-OT') return 'LATE-OT';
    if (r.status === 'present')      return 'Present';
    return 'Pending';
  };

  const present  = recs.filter(r => r.status === 'present').length;
  const absent   = recs.filter(r => r.status === 'absent').length;
  const holidays = recs.filter(r => r.status === 'holiday').length;
  const totalOTMins = recs.reduce((s, r) => s + (r.otMinutes || 0), 0);

  if (fmt === 'csv') {
    const rows = [
      [`OT Tracker — ${titleLabel}`],
      [`Generated: ${getManilaDate().toLocaleDateString('en-PH')}`],
      [`Present: ${present}`, `Absent: ${absent}`, `Holidays: ${holidays}`, `Total OT: ${minutesToHm(totalOTMins)}`],
      [],
      ['Date','Time Out','Status','Work Hours','Overtime','OT Used'],
      ...recs.map(r => [
        formatDateShort(r.date),
        r.timeOutDisplay || (r.status==='absent'?'ABS':r.status==='holiday'?'HOL':'—'),
        statusLabel(r),
        r.workMinutes != null ? minutesToHm(r.workMinutes) : '—',
        r.otMinutes > 0 ? minutesToHm(r.otMinutes) : '—',
        r.otUsageType ? otUsageShortLabel(r.otUsageType) : '—',
      ])
    ];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `OT_Tracker_${fileLabel}.csv`; a.click();
    showToast('CSV downloaded ✓', 'success');
  } else {
    // PDF via print-ready HTML
    const html = `<!DOCTYPE html><html><head><title>OT Tracker — ${titleLabel}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; color: #1E293B; padding: 20px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .meta { color: #64748B; font-size: 11px; margin-bottom: 16px; }
  .summary { display: flex; gap: 24px; margin-bottom: 16px; }
  .summary div { background: #F1F5F9; padding: 8px 14px; border-radius: 6px; }
  .summary strong { display: block; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { background: #1E293B; color: #fff; padding: 7px 10px; text-align: left; font-size: 11px; }
  td { padding: 6px 10px; border-bottom: 1px solid #E2E8F0; font-size: 11px; }
  tr:nth-child(even) td { background: #F8FAFC; }
  .badge { padding: 2px 7px; border-radius: 99px; font-size: 10px; font-weight: 600; }
  .p { background: #ECFDF5; color: #10B981; } .a { background: #FEF2F2; color: #EF4444; }
  .h { background: #EDE9FE; color: #7C3AED; } .ot { background: #FFFBEB; color: #F59E0B; }
</style></head><body>
<h1>OT Tracker — ${titleLabel}</h1>
<div class="meta">Exported: ${getManilaDate().toLocaleDateString('en-PH', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
<div class="summary">
  <div><strong>${present}</strong>Days Present</div>
  <div><strong>${absent}</strong>Days Absent</div>
  <div><strong>${holidays}</strong>Holidays</div>
  <div><strong>${minutesToHm(totalOTMins)}</strong>Total OT</div>
</div>
<table>
<tr><th>Date</th><th>Time Out</th><th>Status</th><th>Work Hours</th><th>Overtime</th><th>OT Used</th></tr>
${recs.map(r => `<tr>
  <td>${formatDateShort(r.date)}</td>
  <td>${r.timeOutDisplay || (r.status==='absent'?'ABS':r.status==='holiday'?'HOL':'—')}</td>
  <td><span class="badge ${r.status==='present'?'p':r.status==='absent'?'a':r.status==='holiday'?'h':''}">${statusLabel(r)}</span></td>
  <td>${r.workMinutes != null ? minutesToHm(r.workMinutes) : '—'}</td>
  <td>${r.otMinutes > 0 ? `<span class="badge ot">${minutesToHm(r.otMinutes)}</span>` : '—'}</td>
  <td>${r.otUsageType ? otUsageShortLabel(r.otUsageType) : '—'}</td>
</tr>`).join('')}
</table>
</body></html>`;
    const win = window.open('', '_blank');
    win.document.write(html); win.document.close();
    win.onload = () => { win.print(); };
    showToast('PDF print dialog opened ✓', 'success');
  }
  closeModal('export-modal');
}

// ═══════════════════════════════════════════════
// UNIFIED RECORD MODAL — multi-mode
// Modes: 'view' | 'confirm-edit' | 'edit' | 'confirm-delete'
// ═══════════════════════════════════════════════

function setModalMode(mode) {
  const rec = allRecords.find(r => r.id === modalRecordId);
  if (!rec && mode !== 'view') return;

  const titleEl  = document.getElementById('record-modal-title');
  const bodyEl   = document.getElementById('record-modal-body');
  const footerEl = document.getElementById('record-modal-footer');

  if (mode === 'view') {
    renderViewMode(rec, titleEl, bodyEl, footerEl);
  } else if (mode === 'confirm-edit') {
    renderConfirmEditMode(rec, titleEl, bodyEl, footerEl);
  } else if (mode === 'edit') {
    renderEditMode(rec, titleEl, bodyEl, footerEl);
  } else if (mode === 'confirm-delete') {
    renderConfirmDeleteMode(rec, titleEl, bodyEl, footerEl);
  } else if (mode === 'confirm-undo') {
    renderConfirmUndoMode(rec, titleEl, bodyEl, footerEl);
  }
}

// ── VIEW mode ────────────────────────────────
function renderViewMode(rec, titleEl, bodyEl, footerEl) {
  const today = getDateKey();
  const isAbsent    = rec.status === 'absent';
  const isHoliday   = rec.status === 'holiday';
  const isOTLeave   = rec.status === 'ot-leave';
  const isPresent   = rec.status === 'present';
  const notTimedOut = !rec.timeOutStamp && !isAbsent && !isHoliday && !isOTLeave;
  const isToday     = rec.id === today;
  const { workStart, workEnd } = getEffectiveWorkHours(rec.id);

  titleEl.textContent = 'Record Details';

  const showStatusBtns = notTimedOut && isToday;

  const presentSection = `
    <div id="present-input-section" class="hidden" style="margin-top:.75rem;padding:.75rem;background:var(--primary-light);border-radius:8px;border:1px solid #BFDBFE">
      <label class="form-label" style="font-size:.78rem">Enter your Time Out:</label>
      <div style="display:flex;gap:.5rem;align-items:center;margin-top:.3rem">
        <input class="form-control" type="time" id="modal-timeout-input" style="flex:1"/>
        <button class="btn btn-primary btn-sm" onclick="confirmPresentTimeout('${rec.id}')">Confirm</button>
      </div>
    </div>`;

  let statusBadge;
  if (isAbsent)       statusBadge = `<span class="badge badge-danger">Absent</span>`;
  else if (isHoliday) statusBadge = `<span class="badge badge-holiday">Holiday</span>`;
  else if (isOTLeave) statusBadge = `<span class="badge badge-ot-leave">${rec.otUsageType || 'OT-L'}</span>`;
  else if (isPresent) statusBadge = `<span class="badge badge-success">Present</span>`;
  else                statusBadge = `<span class="badge badge-gray">Pending</span>`;

  let timeOutValue = rec.timeOutDisplay || '—';
  if (isAbsent)  timeOutValue = 'ABS';
  if (isHoliday) timeOutValue = 'HOL';
  if (isOTLeave) timeOutValue = rec.otUsageType || 'OT-L';

  bodyEl.innerHTML = `
    <div style="display:grid;gap:.65rem">
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Date</span>
        <strong>${formatDateLong(rec.date)}</strong>
      </div>
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Status</span>
        ${statusBadge}
      </div>
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Work Schedule</span>
        <strong>${formatWorkRange(workStart, workEnd)}</strong>
      </div>
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Time Out</span>
        <strong>${timeOutValue}</strong>
      </div>
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Work Hours</span>
        <strong>${rec.workMinutes != null ? minutesToHm(rec.workMinutes) : '—'}</strong>
      </div>
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Overtime</span>
        <strong style="color:var(--accent)">${rec.otMinutes > 0 ? minutesToHm(rec.otMinutes) : 'None'}</strong>
      </div>
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">OT Used</span>
        <span class="badge ${(rec.otUsedOn || isOTFundedUsage(rec.otUsageType)) ? 'badge-success' : 'badge-gray'}">${rec.otUsedOn ? `Yes (${formatDateShort(rec.otUsedOn)})` : isOTFundedUsage(rec.otUsageType) ? `Yes (${formatDateShort(rec.date)})` : 'No'}</span>
      </div>
      ${rec.otUsageType ? `
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Usage Type</span>
        <strong>${otUsageFullLabel(rec.otUsageType)}</strong>
      </div>` : ''}
      ${isOTFundedUsage(rec.otUsageType) ? `
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Hours Used</span>
        <strong>${minutesToHm(rec.otUsageMins || 0)}</strong>
      </div>` : ''}
      ${rec.otOffsetDates && rec.otOffsetDates.length ? `
      <div class="flex justify-between items-center" style="align-items:flex-start;gap:1rem">
        <span class="text-sm" style="color:var(--text-light);white-space:nowrap">Offset Dates</span>
        <strong style="text-align:right;font-size:.82rem">${rec.otOffsetDates.map(d => formatDateShort(d)).join(', ')}</strong>
      </div>` : ''}
      ${isOTLeave && rec.otSourceId ? `
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">OT Source</span>
        <span style="font-size:.78rem;color:var(--text-light)">${formatDateShort(rec.otSourceId)}</span>
      </div>` : ''}
      ${rec.otUsageNote ? `<div style="margin-top:.25rem;padding:.6rem .8rem;background:var(--bg);border-radius:7px;font-size:.82rem;color:var(--text-light)">${rec.otUsageNote}</div>` : ''}
      ${rec.note ? `<div style="margin-top:.25rem;padding:.6rem .8rem;background:var(--bg);border-radius:7px;font-size:.82rem">${rec.note}</div>` : ''}
      ${showStatusBtns ? `
        <div style="border-top:1px solid var(--border);padding-top:.75rem;margin-top:.25rem">
          <div style="font-size:.75rem;font-weight:600;color:var(--text-light);margin-bottom:.5rem">LOG STATUS FOR TODAY</div>
          <div style="display:flex;gap:.5rem">
            <button class="btn btn-danger btn-sm" style="flex:1" onclick="markAbsentFromModal('${rec.id}')">✗ Absent</button>
            <button class="btn btn-sm" style="flex:1;background:#7C3AED;color:#fff" onclick="markHolidayFromModal('${rec.id}')">🎌 Holiday</button>
            <button class="btn btn-success btn-sm" style="flex:1" onclick="showPresentInput()">✓ Present</button>
          </div>
          ${presentSection}
        </div>` : ''}
    </div>`;

  footerEl.innerHTML = `
    <button class="btn btn-ghost" style="color:var(--danger);margin-right:auto" onclick="setModalMode('confirm-delete')">🗑 Delete</button>
    ${rec.otUsageType ? `<button class="btn btn-ghost" onclick="setModalMode('confirm-undo')">↩ Undo Leave/Offset</button>` : ''}
    <button class="btn btn-primary" onclick="setModalMode('confirm-edit')">✏️ Edit</button>
    <button class="btn btn-ghost" onclick="closeModal('record-modal')">Close</button>`;
}

// ── CONFIRM EDIT mode ─────────────────────────
function renderConfirmEditMode(rec, titleEl, bodyEl, footerEl) {
  titleEl.textContent = 'Edit Record';
  bodyEl.innerHTML = `
    <p style="font-size:.88rem;color:var(--text)">Are you sure you want to edit the record for <strong>${formatDateLong(rec.date)}</strong>?</p>`;
  footerEl.innerHTML = `
    <button class="btn btn-ghost" onclick="setModalMode('view')">No</button>
    <button class="btn btn-primary" onclick="setModalMode('edit')">Yes</button>`;
}

// ── EDIT mode ─────────────────────────────────
function renderEditMode(rec, titleEl, bodyEl, footerEl) {
  const { workStart, workEnd } = getEffectiveWorkHours(rec.id);
  editOffsetDates = null; // offset dates stay as saved until the user re-picks them

  titleEl.textContent = 'Edit Record';

  // Pre-calc display values
  let workDisp = rec.workMinutes != null ? minutesToHm(rec.workMinutes) : '—';
  let otDisp   = rec.otMinutes   != null ? minutesToHm(rec.otMinutes)   : '—';
  // Native <input type="time"> needs 24h "HH:MM" — convert from the stored "5:30 PM" display string
  const existingParsedTime = rec.timeOutDisplay ? parseTime12(rec.timeOutDisplay) : null;
  const existingTimeVal    = existingParsedTime ? hmToTimeInput(existingParsedTime.h, existingParsedTime.m) : '';
  const existingInParsed   = rec.timeInDisplay ? parseTime12(rec.timeInDisplay) : timeInputToHm(workStart);
  const existingInVal      = existingInParsed ? hmToTimeInput(existingInParsed.h, existingInParsed.m) : workStart;

  bodyEl.innerHTML = `
    <div class="form-group">
      <label class="form-label">Date</label>
      <input class="form-control" type="date" id="em-date" value="${rec.date}" readonly style="background:var(--bg);color:var(--text-light);cursor:default"/>
    </div>
    <div class="form-group">
      <label class="form-label">Status</label>
      <select class="form-control" id="em-status" onchange="handleEditStatusChange()">
        <option value="present" ${rec.status==='present'?'selected':''}>Present</option>
        <option value="absent"  ${rec.status==='absent'?'selected':''}>Absent</option>
        <option value="holiday" ${rec.status==='holiday'?'selected':''}>Holiday</option>
      </select>
      <div class="form-hint">Changing to Absent or Holiday clears the time out.</div>
    </div>
    <div class="form-group" id="em-work-hours-group">
      <div class="form-label-row" style="margin-bottom:.5rem">
        <label class="form-label" style="margin-bottom:0">Work Hours</label>
        <button type="button" class="work-edit-btn-visible" onclick="toggleEditModalWorkHours()" title="Customize work hours for this date only">
          ✏️ Override
        </button>
      </div>
      <div id="em-work-hours-editor" class="hidden" style="background:var(--bg);border-radius:8px;padding:.75rem;margin-bottom:.5rem;border:1px solid var(--border)">
        <div style="font-size:.75rem;font-weight:600;color:var(--text-light);margin-bottom:.5rem">Custom hours for this date only</div>
        <div class="form-row">
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label" style="font-size:.75rem">Work Start</label>
            <input class="form-control" type="time" id="em-work-start" value="${workStart}" oninput="recalcEditModal()"/>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label" style="font-size:.75rem">Work End</label>
            <input class="form-control" type="time" id="em-work-end" value="${workEnd}" oninput="recalcEditModal()"/>
          </div>
        </div>
      </div>
    </div>
    <div class="form-group" id="em-timein-group">
      <label class="form-label">Time In</label>
      <input class="form-control" type="time" id="em-timein" value="${existingInVal}" oninput="recalcEditModal()"/>
      <div class="form-hint">Defaults to your Work Start time — edit if you clocked in at a different time.</div>
    </div>
    <div class="form-group" id="em-timeout-group">
      <label class="form-label">Time Out</label>
      <input class="form-control" type="time" id="em-timeout" value="${existingTimeVal}" oninput="recalcEditModal()"/>
      <div class="form-hint">Tap to set your Time Out — Overtime is calculated automatically</div>
    </div>
    <div class="hidden" id="em-undertime-warning" style="display:flex;gap:.5rem;align-items:flex-start;background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;border-radius:8px;padding:.5rem .65rem;font-size:.76rem;margin:-.5rem 0 1rem">
      <span>⚠️</span><span id="em-undertime-warning-text"></span>
    </div>
    <div class="hidden" id="em-early-timeout-warning" style="display:flex;gap:.5rem;align-items:flex-start;background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;border-radius:8px;padding:.5rem .65rem;font-size:.76rem;margin:-.5rem 0 1rem">
      <span>⚠️</span><span>You timed out before your work hours end. Use OT hours if you have any offset.</span>
    </div>
    <div class="form-row" style="margin-bottom:1rem" id="em-calc-group">
      <div style="background:var(--bg);border-radius:7px;padding:.55rem .75rem;border:1px solid var(--border)">
        <div style="font-size:.68rem;color:var(--text-light);font-weight:600;margin-bottom:.15rem">WORK HOURS</div>
        <div style="font-weight:700;color:var(--text)" id="em-work-display">${workDisp}</div>
      </div>
      <div style="background:var(--accent-light);border-radius:7px;padding:.55rem .75rem;border:1px solid #FDE68A">
        <div style="font-size:.68rem;color:var(--text-light);font-weight:600;margin-bottom:.15rem">OVERTIME</div>
        <div style="font-weight:700;color:var(--accent)" id="em-ot-display">${otDisp}</div>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Note (optional)</label>
      <textarea class="form-control" id="em-note" rows="2" style="resize:vertical">${rec.note || ''}</textarea>
    </div>
    <div class="form-group" style="background:var(--bg);border-radius:8px;padding:.85rem;border:1px solid var(--border)">
      <div style="font-size:.78rem;font-weight:700;color:var(--text);margin-bottom:.2rem">Leave/Offset</div>
      <div style="font-size:.72rem;color:var(--text-light);margin-bottom:.6rem">${rec.otUsageType ? 'Change or remove the leave/offset declared for this day.' : "Forgot to file a leave or offset for this day? You can declare it here."}</div>
      <div class="form-group" style="margin-bottom:.6rem">
        <label class="form-label" style="font-size:.78rem">Usage Type</label>
        <select class="form-control" id="em-usage-type" onchange="handleEditUsageTypeChange()">
          <option value="NONE"    ${!rec.otUsageType ? 'selected' : ''}>${rec.otUsageType ? 'None — remove usage' : 'None — no leave/offset'}</option>
          <option value="SL"      ${rec.otUsageType==='SL'     ?'selected':''}>Sick Leave (SL)</option>
          <option value="VL"      ${rec.otUsageType==='VL'     ?'selected':''}>Vacation Leave (VL)</option>
          <option value="BL"      ${rec.otUsageType==='BL'     ?'selected':''}>Birthday Leave (BL)</option>
          <option value="LATE-OT" ${rec.otUsageType==='LATE-OT'?'selected':''}>Offset (OS)</option>
          ${rec.otUsageType==='FL-OT' ? '<option value="FL-OT" selected>Full Day Leave (FL-OT)</option>' : ''}
          ${rec.otUsageType==='HD-OT' ? '<option value="HD-OT" selected>Half Day (HD-OT)</option>' : ''}
        </select>
      </div>
      <div class="form-group hidden" id="em-usage-hours-group" style="margin-bottom:.4rem">
        <button type="button" class="btn btn-ghost btn-sm" onclick="openOffsetPicker('edit')">Select Offset Dates</button>
        <div class="form-hint" id="em-offset-summary"></div>
      </div>
      <div class="hidden" id="em-usage-insufficient-warning" style="display:flex;gap:.5rem;align-items:flex-start;background:#FEF2F2;border:1px solid #FCA5A5;color:#B91C1C;border-radius:8px;padding:.5rem .65rem;font-size:.76rem;margin-top:.3rem">
        <span>⚠️</span><span id="em-usage-insufficient-warning-text"></span>
      </div>
    </div>`;

  footerEl.innerHTML = `
    <button class="btn btn-ghost" onclick="cancelEditMode()">Cancel</button>
    <button class="btn btn-primary" onclick="saveEditFromModal()">Save Changes</button>`;

  // Apply initial status-based disable state
  // The Status dropdown only has present/absent/holiday — for a Full Day Leave (OT) record,
  // which has no matching option, explicitly default it to Absent so what's shown matches
  // what will actually be saved if the OT usage gets removed here.
  if (rec.status === 'ot-leave') {
    const statusEl = document.getElementById('em-status');
    if (statusEl) statusEl.value = 'absent';
  }
  setTimeout(() => { handleEditStatusChange(); handleEditUsageTypeChange(); }, 0);
}

// Live-checks a pending OT-usage-type edit against remaining OT (excluding this record's own
// currently-declared amount, since we're changing it, not adding a new usage on top of it)
function handleEditUsageTypeChange() {
  const typeEl = document.getElementById('em-usage-type');
  if (!typeEl) return; // record has no otUsageType — nothing to edit
  const type = typeEl.value;
  const og   = document.getElementById('em-usage-hours-group'); // holds the Select Offset Dates button
  const wh   = getWorkdayHours();
  const rec  = allRecords.find(r => r.id === modalRecordId);

  let deductMins = 0, offsetDates = [], legacyOffset = false;
  if (og) og.classList.toggle('hidden', type !== 'LATE-OT');

  if (type === 'FL-OT') {
    deductMins = Math.round(wh * 60);
  } else if (type === 'HD-OT') {
    deductMins = Math.round((wh / 2) * 60);
  } else if (type === 'LATE-OT') {
    if (editOffsetDates !== null) {
      offsetDates = editOffsetDates;
      deductMins  = getOffsetMins(offsetDates);
    } else if (rec && rec.otUsageType === 'LATE-OT') {
      // untouched: keep what was saved (older offsets have hours but no dates)
      offsetDates  = rec.otOffsetDates || [];
      deductMins   = rec.otUsageMins || 0;
      legacyOffset = offsetDates.length === 0;
    }
    const sum = document.getElementById('em-offset-summary');
    if (sum) {
      sum.textContent = offsetDates.length
        ? `${offsetDates.length} date${offsetDates.length !== 1 ? 's' : ''} selected — total ${minutesToHHMM(deductMins)}`
        : (legacyOffset ? `Current offset: ${minutesToHHMM(deductMins)} (no dates recorded)` : 'No dates selected.');
    }
  }

  // Validate: OT-funded usages against remaining OT; leaves against the yearly credits
  let message = '';
  if (isOTFundedUsage(type)) {
    const remOTExcludingThis = getRemainingOTMinutesExcluding(rec ? rec.id : null);
    if (deductMins > 0 && deductMins > remOTExcludingThis) {
      message = `You need ${minutesToHm(deductMins)} but only have ${minutesToHm(remOTExcludingThis)} of OT available.`;
    }
  } else if (isLeaveUsage(type) && rec && rec.otUsageType !== type) {
    const year = rec.date.slice(0, 4);
    const b = getLeaveBalance(allRecords.filter(r => r.id !== rec.id), userSettings, year)[type];
    if (b.remaining <= 0) {
      message = `No ${otUsageFullLabel(type)} credits left for ${year}.${b.total === 0 ? ' Set your leave credits in the Schedule tab.' : ''}`;
    }
  }
  const warning = document.getElementById('em-usage-insufficient-warning');
  const warningText = document.getElementById('em-usage-insufficient-warning-text');
  if (warning) warning.classList.toggle('hidden', !message);
  if (warningText && message) warningText.textContent = message;
  const saveBtn = document.querySelector('#record-modal-footer .btn-primary');
  if (saveBtn) saveBtn.disabled = !!message;
  return { type, deductMins, insufficient: !!message, message, offsetDates, legacyOffset };
}

// Remaining OT if we ignore one specific record's own declared usage (used while editing that
// record's usage type, so it isn't counted as "already used" against itself)
function getRemainingOTMinutesExcluding(excludeId) {
  const others = excludeId ? allRecords.filter(r => r.id !== excludeId) : allRecords;
  return getOTPool(others).remaining;
}

function toggleEditModalWorkHours() {
  const el = document.getElementById('em-work-hours-editor');
  if (el) el.classList.toggle('hidden');
}

function handleEditStatusChange() {
  const status    = document.getElementById('em-status')?.value;
  const isPresent = status === 'present';
  const timeoutGrp = document.getElementById('em-timeout-group');
  const calcGrp    = document.getElementById('em-calc-group');
  const workGrp    = document.getElementById('em-work-hours-group');
  if (timeoutGrp) timeoutGrp.style.opacity = isPresent ? '1' : '.45';
  if (calcGrp)    calcGrp.style.opacity    = isPresent ? '1' : '.45';
  if (workGrp)    workGrp.style.opacity    = isPresent ? '1' : '.45';
  const timeoutInput = document.getElementById('em-timeout');
  if (timeoutInput) {
    timeoutInput.disabled = !isPresent;
    if (!isPresent) {
      timeoutInput.value = '';
      const otEl   = document.getElementById('em-ot-display');
      const workEl = document.getElementById('em-work-display');
      if (otEl)   otEl.textContent   = '—';
      if (workEl) workEl.textContent = '—';
    }
  }
}

function recalcEditModal() {
  const tin    = document.getElementById('em-timein')?.value;
  const tout   = (document.getElementById('em-timeout')?.value || '').trim();
  const wEnd   = document.getElementById('em-work-end')?.value   || getEffectiveWorkHours(modalRecordId).workEnd;
  const fallbackStart = document.getElementById('em-work-start')?.value || getEffectiveWorkHours(modalRecordId).workStart;

  const otEl   = document.getElementById('em-ot-display');
  const workEl = document.getElementById('em-work-display');
  const warnEl = document.getElementById('em-undertime-warning');
  if (!tout || !wEnd) { if(otEl) otEl.textContent='—'; if(workEl) workEl.textContent='—'; if(warnEl) warnEl.classList.add('hidden'); return; }

  const parsed = timeInputToHm(tout);
  if (!parsed) { if(otEl) otEl.textContent='Invalid time'; return; }

  const s = timeInputToHm(tin || fallbackStart), e = timeInputToHm(wEnd);
  if (!s || !e) return;
  const base = new Date();
  const toMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0).getTime();
  const sMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), s.h, s.m, 0).getTime();
  const eMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();
  const workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000) - getBreakMinutes());
  const otMinsRaw = Math.max(0, Math.round((toMs - eMs) / 60_000));
  const otMins   = applyOTRule(otMinsRaw);
  if (workEl) workEl.textContent = minutesToHm(workMins + otMins);
  if (otEl)   otEl.textContent   = otMins > 0 ? minutesToHm(otMins) : 'None';

  // Soft warnings — never block saving.
  // If this day already has a declared Half Day / Undertime usage, flag checking out earlier
  // than THAT accounts for. Otherwise, flag checking out before Work End with no OT declared
  // at all, so the shortfall doesn't go unaccounted for.
  const earlyWarn = document.getElementById('em-early-timeout-warning');
  if (warnEl) {
    const rec = allRecords.find(r => r.id === modalRecordId);
    const minMins = computeMinTimeOutForUsage(rec, s);
    if (minMins != null && (parsed.h * 60 + parsed.m) < minMins) {
      warnEl.classList.remove('hidden');
      const label = rec.otUsageType === 'HD-OT' ? 'half day' : 'offset';
      document.getElementById('em-undertime-warning-text').textContent =
        `You're checking out earlier than your declared ${label} accounts for. Minimum Time Out: ${minutesToClockLabel(minMins)}.`;
      if (earlyWarn) earlyWarn.classList.add('hidden');
    } else {
      warnEl.classList.add('hidden');
      const noUsage = !rec || !rec.otUsageType;
      if (earlyWarn) earlyWarn.classList.toggle('hidden', !(noUsage && isEarlyCheckoutWithoutOT(parsed, e)));
    }
  }
}

// True when someone with NO OT usage declared for that day clocks out before Work End —
// they may want to use OT hours to cover the shortfall instead of it going unaccounted for.
function isEarlyCheckoutWithoutOT(toutHm, workEndHm) {
  if (!toutHm || !workEndHm) return false;
  if (userSettings.otCountingRule && userSettings.otCountingRule.startRule === 'none') return false; // no OT to offset with
  return (toutHm.h * 60 + toutHm.m) < (workEndHm.h * 60 + workEndHm.m);
}

// For a Half Day / Undertime OT-usage record, computes the minimum valid Time Out given a Time In —
// used to softly warn (never block) if the logged Time Out falls short of what was declared.
function computeMinTimeOutForUsage(rec, tinHm) {
  if (!rec || !rec.otUsageType || rec.otUsageType === 'FL-OT' || isLeaveUsage(rec.otUsageType) || !tinHm) return null;
  const wh = getWorkdayHours(); // hours, already break-excluded
  if (rec.otUsageType === 'HD-OT') {
    const expectedWorkMins = Math.round((wh / 2) * 60); // half day assumed break-free
    return (tinHm.h * 60 + tinHm.m) + expectedWorkMins;
  }
  // LATE-OT (displayed as Undertime (UT-OT))
  const declaredMins = rec.otUsageMins || 0;
  const expectedWorkMins = Math.max(0, Math.round(wh * 60) - declaredMins);
  return (tinHm.h * 60 + tinHm.m) + getBreakMinutes() + expectedWorkMins;
}

function minutesToClockLabel(totalMins) {
  const h = Math.floor(totalMins / 60) % 24, m = ((totalMins % 60) + 60) % 60;
  return formatTime12(h, m);
}

function cancelEditMode() {
  showToast('Modification cancelled', 'default');
  setModalMode('view');
}

async function saveEditFromModal() {
  const rec      = allRecords.find(r => r.id === modalRecordId);
  if (!rec) return;
  const date     = rec.date;
  const dropStatus = document.getElementById('em-status')?.value || 'present';
  const tin      = document.getElementById('em-timein')?.value || getEffectiveWorkHours(date).workStart;
  const tout     = (dropStatus === 'present') ? (document.getElementById('em-timeout')?.value || '').trim() : '';
  const wStart   = document.getElementById('em-work-start')?.value || getEffectiveWorkHours(date).workStart;
  const wEnd     = document.getElementById('em-work-end')?.value   || getEffectiveWorkHours(date).workEnd;
  const note     = document.getElementById('em-note')?.value.trim() || '';

  // If this record has an editable OT Usage section, re-validate + capture the (possibly changed) values
  let usageUpdate = null;
  let newOffsetDates = null; // null = offset dates unchanged
  if (document.getElementById('em-usage-type')) {
    const result = handleEditUsageTypeChange();
    if (result && result.insufficient) {
      showToast(result.message, 'error');
      return;
    }
    if (result && result.type === 'LATE-OT' && !result.offsetDates.length && !result.legacyOffset) {
      showToast('Please select the offset dates.', 'error');
      return;
    }
    if (result && result.type === 'NONE' && rec.otUsageType) {
      // Remove just the usage tags — the record itself stays, with whatever status/fields
      // are set in the form below (unlike the dedicated Undo button, this never deletes).
      usageUpdate = {
        otUsageType: firebase.firestore.FieldValue.delete(),
        otUsageMins: firebase.firestore.FieldValue.delete(),
        otUsageNote: firebase.firestore.FieldValue.delete(),
        otUsageDate: firebase.firestore.FieldValue.delete(),
        otSourceId:  firebase.firestore.FieldValue.delete(),
        otOffsetDates: firebase.firestore.FieldValue.delete(),
      };
      newOffsetDates = [];
    } else if (result && result.type !== 'NONE') {
      // New or changed usage — declared here retroactively if the record didn't have one
      usageUpdate = { otUsageType: result.type, otUsageMins: result.deductMins };
      if (result.type === 'LATE-OT') {
        if (!result.legacyOffset) { usageUpdate.otOffsetDates = result.offsetDates; newOffsetDates = result.offsetDates; }
      } else {
        if (rec.otOffsetDates && rec.otOffsetDates.length) usageUpdate.otOffsetDates = firebase.firestore.FieldValue.delete();
        newOffsetDates = [];
      }
    }
  }

  let workMins = null, otMins = null, status = dropStatus;

  if (dropStatus === 'absent' || dropStatus === 'holiday') {
    workMins = 0; otMins = 0;
  } else {
    const parsed = tout ? timeInputToHm(tout) : null;
    const inParsed = timeInputToHm(tin);
    if (parsed && inParsed && wEnd) {
      const e = timeInputToHm(wEnd);
      const base = new Date();
      const toMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0).getTime();
      const sMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), inParsed.h, inParsed.m, 0).getTime();
      const eMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();
      workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000) - getBreakMinutes());
      const _otRaw = Math.max(0, Math.round((toMs - eMs) / 60_000));
      otMins   = applyOTRule(_otRaw);
      workMins += otMins; // Work Hours = base shift (minus break) + OT, for every user
    }
  }

  const parsed = (dropStatus === 'present' && tout) ? timeInputToHm(tout) : null;
  const inParsedForSave = (dropStatus === 'present') ? timeInputToHm(tin) : null;
  const defaultStart = userSettings.workStart || '08:00';
  const defaultEnd   = userSettings.workEnd   || '17:00';
  const isCustom     = (dropStatus === 'present') && (wStart !== defaultStart || wEnd !== defaultEnd);

  const data = {
    date, status, note,
    timeInDisplay: inParsedForSave ? formatTime12(inParsedForSave.h, inParsedForSave.m) : null,
    timeOutDisplay: parsed ? formatTime12(parsed.h, parsed.m) : null,
    timeOutStamp: parsed ? firebase.firestore.Timestamp.fromDate(
      (() => { const d = getManilaDate(); d.setHours(parsed.h, parsed.m, 0, 0); return d; })()
    ) : null,
    workMinutes: workMins, otMinutes: otMins,
    customWorkStart: isCustom ? wStart : null,
    customWorkEnd:   isCustom ? wEnd   : null,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    ...(usageUpdate || {}),
  };

  if (isCustom) customWorkHours[date] = { workStart: wStart, workEnd: wEnd };
  else delete customWorkHours[date];

  const proceed = await showConfirmDialog({
    title: 'Save Changes?',
    message: `Are you sure you want to save these changes to the record for <strong>${formatDateLong(date)}</strong>?`,
    confirmLabel: 'Save Changes',
  });
  if (!proceed) return;

  const btn = document.querySelector('#record-modal-footer .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await db.collection('users').doc(currentUser.uid).collection('attendance').doc(date).update(data);
    if (newOffsetDates !== null) await syncOffsetSources(date, rec.otOffsetDates || [], newOffsetDates);
    showToast('Record modified ✓', 'success');
    const hasUsage = !!(usageUpdate ? usageUpdate.otUsageType : rec.otUsageType);
    if (dropStatus === 'present' && !hasUsage && isEarlyCheckoutWithoutOT(parsed, timeInputToHm(wEnd))) {
      showToast('⚠ You timed out before your work hours end. Use OT hours if you have any offset.', 'default');
    }
    await loadRecords();
    setModalMode('view');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
  }
}

// ── CONFIRM DELETE mode ───────────────────────
function renderConfirmDeleteMode(rec, titleEl, bodyEl, footerEl) {
  titleEl.textContent = 'Delete Record';
  bodyEl.innerHTML = `
    <p style="font-size:.88rem;color:var(--text)">Are you sure you want to delete the record for <strong>${formatDateLong(rec.date)}</strong>? This cannot be undone.</p>`;
  footerEl.innerHTML = `
    <button class="btn btn-ghost" onclick="setModalMode('view')">No</button>
    <button class="btn btn-danger" onclick="executeDelete('${rec.id}')">Yes, Delete</button>`;
}

async function executeDelete(id) {
  try {
    const delRec = allRecords.find(r => r.id === id);
    await db.collection('users').doc(currentUser.uid).collection('attendance').doc(id).delete();
    if (delRec && delRec.otOffsetDates && delRec.otOffsetDates.length) await syncOffsetSources(id, delRec.otOffsetDates, []);
    delete customWorkHours[id];
    showToast('Record deleted.', 'default');
    closeModal('record-modal');
    await loadRecords();

    // OT is pooled and derived fresh from all records, so deleting one automatically "reverts"
    // its contribution — same as Undo. This just surfaces the rare case where the record deleted
    // had earned OT that was already used elsewhere, leaving the pool short.
    const pool = getOTPool(allRecords);
    if (pool.remaining < 0) {
      showToast(`⚠ Deleting this record left your OT balance short by ${minutesToHm(-pool.remaining)}.`, 'default');
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Open record modal (view mode) ─────────────
function viewRecord(id) {
  modalRecordId = id;
  openModal('record-modal');
  setModalMode('view');
}

// ── Absent / Present from modal ───────────────
async function markAbsentFromModal(id) {
  try {
    await db.collection('users').doc(currentUser.uid).collection('attendance').doc(id)
            .update({ status: 'absent', timeOutStamp: null, timeOutDisplay: null, workMinutes: 0, otMinutes: 0 });
    showToast('Marked as Absent', 'warning');
    await loadRecords();
    setModalMode('view');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function markHolidayFromModal(id) {
  try {
    await db.collection('users').doc(currentUser.uid).collection('attendance').doc(id)
            .update({ status: 'holiday', timeOutStamp: null, timeOutDisplay: null, workMinutes: 0, otMinutes: 0 });
    showToast('Marked as Holiday 🎌', 'success');
    await loadRecords();
    setModalMode('view');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

function showPresentInput() {
  const section = document.getElementById('present-input-section');
  if (section) section.classList.remove('hidden');
  const input = document.getElementById('modal-timeout-input');
  if (input) input.focus();
}

async function confirmPresentTimeout(id) {
  const input = document.getElementById('modal-timeout-input');
  const toutVal = input ? input.value.trim() : '';
  if (!toutVal) { showToast('Please set your Time Out.', 'error'); return; }

  const parsed = timeInputToHm(toutVal);
  if (!parsed) { showToast('Invalid time.', 'error'); return; }
  const tout = formatTime12(parsed.h, parsed.m);

  const rec = allRecords.find(r => r.id === id);
  const { workStart, workEnd } = getEffectiveWorkHours(id);
  const s = rec && rec.timeInDisplay ? parseTime12(rec.timeInDisplay) : timeInputToHm(workStart);
  const e = timeInputToHm(workEnd);
  const base = getManilaDate();
  const toMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0).getTime();
  const sMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), s.h, s.m, 0).getTime();
  const eMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();
  const workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000) - getBreakMinutes());
  const otMinsRaw = Math.max(0, Math.round((toMs - eMs) / 60_000));
  const otMins   = applyOTRule(otMinsRaw);
  const totalWorkMins = workMins + otMins; // Work Hours = base shift (minus break) + OT, for every user

  try {
    await db.collection('users').doc(currentUser.uid).collection('attendance').doc(id)
            .update({
              status: 'present',
              timeOutDisplay: tout,
              timeOutStamp: firebase.firestore.Timestamp.fromDate(
                (() => { const d = getManilaDate(); d.setHours(parsed.h, parsed.m, 0, 0); return d; })()
              ),
              workMinutes: totalWorkMins,
              otMinutes: otMins,
            });
    showToast(`Time Out logged at ${tout}`, 'success');

    // Soft warnings — never block.
    // If this day already has a declared Half Day / Undertime usage, flag checking out earlier
    // than THAT accounts for. Otherwise, flag checking out before Work End with no OT declared.
    const minMins = computeMinTimeOutForUsage(rec, s);
    if (minMins != null && (parsed.h * 60 + parsed.m) < minMins) {
      const label = rec.otUsageType === 'HD-OT' ? 'half day' : 'offset';
      showToast(`⚠ You checked out earlier than your declared ${label} accounts for (minimum: ${minutesToClockLabel(minMins)}).`, 'default');
    } else if ((!rec || !rec.otUsageType) && isEarlyCheckoutWithoutOT(parsed, e)) {
      showToast('⚠ You timed out before your work hours end. Use OT hours if you have any offset.', 'default');
    }

    await loadRecords();
    setModalMode('view');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ── Status dropdown handler (Add modal) ──────
function handleStatusChange() {
  const status    = document.getElementById('edit-status')?.value;
  const timeoutGrp = document.getElementById('timeout-group');
  const calcGrp    = document.getElementById('calc-display-group');
  const workGrp    = document.getElementById('work-hours-group');
  const isPresent  = status === 'present';
  if (timeoutGrp) timeoutGrp.style.opacity = isPresent ? '1' : '.45';
  if (calcGrp)    calcGrp.style.opacity    = isPresent ? '1' : '.45';
  if (workGrp)    workGrp.style.opacity    = isPresent ? '1' : '.45';
  const timeoutInput = document.getElementById('edit-timeout');
  if (timeoutInput) {
    timeoutInput.disabled = !isPresent;
    if (!isPresent) {
      timeoutInput.value = '';
      document.getElementById('edit-ot-display').textContent   = '—';
      document.getElementById('edit-work-display').textContent = '—';
    }
  }
}

// ── Add Modal ────────────────────────────────
function openAddModal() {
  editingId = null;
  const today = getDateKey();
  document.getElementById('edit-date').value          = today;
  document.getElementById('edit-timein').value        = userSettings.workStart || '08:00';
  document.getElementById('edit-timeout').value       = '';
  document.getElementById('edit-note').value          = '';
  document.getElementById('edit-work-start').value    = userSettings.workStart || '08:00';
  document.getElementById('edit-work-end').value      = userSettings.workEnd   || '17:00';
  document.getElementById('edit-ot-display').textContent   = '—';
  document.getElementById('edit-work-display').textContent = '—';
  document.getElementById('modal-title').textContent  = 'Add Record';
  const statusEl = document.getElementById('edit-status');
  if (statusEl) statusEl.value = 'present';
  // Reset work hours editor
  const whe = document.getElementById('work-hours-editor');
  if (whe) whe.classList.add('hidden');
  handleStatusChange();
  openModal('add-modal');
}

function openWorkHoursEditor() {
  const wrap = document.getElementById('work-hours-editor');
  if (wrap) wrap.classList.toggle('hidden');
}

function recalcModalOT() {
  const tin    = document.getElementById('edit-timein').value;
  const tout   = document.getElementById('edit-timeout').value.trim();
  const wStart = document.getElementById('edit-work-start').value;
  const wEnd   = document.getElementById('edit-work-end').value;
  const otEl   = document.getElementById('edit-ot-display');
  const workEl = document.getElementById('edit-work-display');
  if (!tout || !wEnd) { if(otEl) otEl.textContent='—'; if(workEl) workEl.textContent='—'; return; }
  const parsed = timeInputToHm(tout);
  if (!parsed) { if(otEl) otEl.textContent='Invalid time'; return; }
  const s = timeInputToHm(tin || wStart), e = timeInputToHm(wEnd);
  if (!s || !e) return;
  const base = new Date();
  const toMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0).getTime();
  const sMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), s.h, s.m, 0).getTime();
  const eMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();
  const workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000) - getBreakMinutes());
  const otMinsRaw = Math.max(0, Math.round((toMs - eMs) / 60_000));
  const otMins   = applyOTRule(otMinsRaw);
  if (workEl) workEl.textContent = minutesToHm(workMins + otMins);
  if (otEl)   otEl.textContent   = otMins > 0 ? minutesToHm(otMins) : 'None';

  // Add Record is always for a fresh record — it never has OT usage declared yet
  const earlyWarn = document.getElementById('edit-early-timeout-warning');
  if (earlyWarn) earlyWarn.classList.toggle('hidden', !isEarlyCheckoutWithoutOT(parsed, e));
}

async function saveRecord() {
  const date      = document.getElementById('edit-date').value;
  const tin       = document.getElementById('edit-timein').value;
  const tout      = document.getElementById('edit-timeout').value.trim();
  const wStart    = document.getElementById('edit-work-start').value;
  const wEnd      = document.getElementById('edit-work-end').value;
  const note      = document.getElementById('edit-note').value.trim();
  const dropStatus = document.getElementById('edit-status')?.value || 'present';
  if (!date) { showToast('Date is required.', 'error'); return; }

  // Warn before silently overwriting an existing day's record
  const existingSnap = await db.collection('users').doc(currentUser.uid).collection('attendance').doc(date).get();
  if (existingSnap.exists) {
    const proceed = await showConfirmDialog({
      title: 'Record Already Exists',
      message: `A record for <strong>${formatDateLong(date)}</strong> already exists. Do you want to overwrite it?`,
      confirmLabel: 'Overwrite',
      danger: true,
    });
    if (!proceed) return;
  }

  let workMins = null, otMins = null, status = dropStatus;

  if (dropStatus === 'absent' || dropStatus === 'holiday') {
    workMins = 0; otMins = 0;
  } else {
    // present — calculate from Time In → Time Out
    const parsed = tout ? timeInputToHm(tout) : null;
    const inParsed = timeInputToHm(tin || wStart);
    if (parsed && inParsed && wEnd) {
      const e = timeInputToHm(wEnd);
      const base = new Date();
      const toMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0).getTime();
      const sMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), inParsed.h, inParsed.m, 0).getTime();
      const eMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();
      workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000) - getBreakMinutes());
      const _otRaw = Math.max(0, Math.round((toMs - eMs) / 60_000));
      otMins   = applyOTRule(_otRaw);
      workMins += otMins; // Work Hours = base shift (minus break) + OT, for every user
    }
  }

  const parsed = (dropStatus === 'present' && tout) ? timeInputToHm(tout) : null;
  const inParsedForSave = (dropStatus === 'present') ? timeInputToHm(tin || wStart) : null;

  const defaultStart = userSettings.workStart || '08:00';
  const defaultEnd   = userSettings.workEnd   || '17:00';
  const isCustom     = (wStart !== defaultStart || wEnd !== defaultEnd);

  const data = {
    date,
    timeInDisplay: inParsedForSave ? formatTime12(inParsedForSave.h, inParsedForSave.m) : null,
    timeOutDisplay: parsed ? formatTime12(parsed.h, parsed.m) : null,
    timeOutStamp: parsed ? firebase.firestore.Timestamp.fromDate(
      (() => { const d = getManilaDate(); d.setHours(parsed.h, parsed.m, 0, 0); return d; })()
    ) : null,
    workMinutes: workMins, otMinutes: otMins, status, note,
    customWorkStart: (dropStatus==='present' && isCustom) ? wStart : null,
    customWorkEnd:   (dropStatus==='present' && isCustom) ? wEnd   : null,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  if (dropStatus==='present' && isCustom) customWorkHours[date] = { workStart: wStart, workEnd: wEnd };
  else delete customWorkHours[date];

  const btn = document.getElementById('btn-save-record');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const ref = db.collection('users').doc(currentUser.uid).collection('attendance').doc(date);
    await ref.set({ ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    showToast('Record saved ✓', 'success');
    if (dropStatus === 'present' && isEarlyCheckoutWithoutOT(parsed, timeInputToHm(wEnd))) {
      showToast('⚠ You timed out before your work hours end. Use OT hours if you have any offset.', 'default');
    }
    closeModal('add-modal');
    await loadRecords();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Record';
  }
}


// ── Tenure Ended ─────────────────────────────
// Archives every attendance record into users/{uid}/companies/{id}/records and saves the job
// details under Companies. Dashboard, Attendance, Overtime and Badges are all derived from the
// attendance collection, so emptying it resets them. Undo (on the Companies page) moves it all back.
let tenureRating = 0;

function setTenureRating(n) {
  tenureRating = (tenureRating === n) ? 0 : n; // tap the same star again to clear
  document.querySelectorAll('#t-rating button').forEach(b => {
    b.style.color = parseInt(b.dataset.v) <= tenureRating ? '#F59E0B' : '#CBD5E1';
  });
}

function openTenureModal() {
  const g = id => document.getElementById(id);
  const dates = allRecords.map(r => r.date).sort();
  g('t-company').value     = userSettings.companyName || '';
  g('t-title').value       = userSettings.jobPosition || '';
  g('t-type').value        = userSettings.userType === 'intern' ? 'Internship / OJT' : 'Full-time';
  g('t-setup').value       = 'On-site';
  g('t-location').value    = '';
  g('t-start').value       = dates[0] || '';
  g('t-end').value         = getDateKey();
  g('t-reason').value      = '';
  g('t-reason-other').value = '';
  g('t-reason-other').classList.add('hidden');
  g('t-description').value = '';
  g('t-skills').value      = '';
  g('t-achievements').value = '';
  tenureRating = 0; setTenureRating(0);
  openModal('tenure-modal');
}

// Runs write operations in batches (Firestore allows 500 per batch)
async function commitInChunks(ops, size = 400) {
  for (let i = 0; i < ops.length; i += size) {
    const batch = db.batch();
    ops.slice(i, i + size).forEach(fn => fn(batch));
    await batch.commit();
  }
}

async function saveTenure() {
  const g = id => document.getElementById(id);
  const company = g('t-company').value.trim();
  const reason  = g('t-reason').value;
  const reasonOther = g('t-reason-other').value.trim();
  const start = g('t-start').value, end = g('t-end').value;

  if (!company)  { showToast('Please enter the company name.', 'error'); return; }
  if (!end)      { showToast('Please set the end date.', 'error'); return; }
  if (start && end < start) { showToast('End date cannot be before the start date.', 'error'); return; }
  if (!reason)   { showToast('Please select a reason for ending your tenure.', 'error'); return; }
  if (reason === 'Other' && !reasonOther) { showToast('Please specify the reason.', 'error'); return; }

  const proceed = await showConfirmDialog({
    title: 'End Tenure?',
    message: `This archives all <strong>${allRecords.length}</strong> attendance record${allRecords.length !== 1 ? 's' : ''} for <strong>${escapeHtml(company)}</strong> and resets your Dashboard, Attendance, Overtime and Badges. You can undo this from the Companies page.`,
    confirmLabel: 'End Tenure',
    danger: true,
  });
  if (!proceed) return;

  const pool = getOTPool(allRecords);
  const stats = {
    records:     allRecords.length,
    presentDays: allRecords.filter(r => r.status === 'present').length,
    absences:    allRecords.filter(r => r.status === 'absent').length,
    holidays:    allRecords.filter(r => r.status === 'holiday').length,
    leaveDays:   allRecords.filter(r => isLeaveUsage(r.otUsageType)).length,
    otEarnedMins: pool.earned,
    otUsedMins:   pool.used,
    workMins:    allRecords.reduce((s, r) => s + (r.workMinutes || 0), 0),
  };

  const btn = g('btn-save-tenure');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const userRef = db.collection('users').doc(currentUser.uid);
    const attCol  = userRef.collection('attendance');
    const compRef = userRef.collection('companies').doc();

    // Read the raw stored docs (not the recalculated view) so Undo restores them exactly
    const snap = await attCol.get();

    await compRef.set({
      companyName: company,
      jobTitle:    g('t-title').value.trim(),
      employmentType: g('t-type').value,
      workSetup:   g('t-setup').value,
      location:    g('t-location').value.trim(),
      startDate:   start || null,
      endDate:     end,
      reason, reasonOther: reason === 'Other' ? reasonOther : '',
      description: g('t-description').value.trim(),
      skills:      g('t-skills').value.split(',').map(x => x.trim()).filter(Boolean).slice(0, 20),
      achievements: g('t-achievements').value.trim(),
      rating:      tenureRating,
      stats,
      settingsSnapshot: { companyName: userSettings.companyName || '', jobPosition: userSettings.jobPosition || '' },
      endedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Copy first, delete after — if anything fails midway the originals are still intact
    const arch = compRef.collection('records');
    await commitInChunks(snap.docs.map(d => b => b.set(arch.doc(d.id), d.data())));
    await commitInChunks(snap.docs.map(d => b => b.delete(attCol.doc(d.id))));

    // The job is over, so clear it as the "current" company
    await userRef.collection('config').doc('settings').set({ companyName: '', jobPosition: '' }, { merge: true });
    clearSettingsCache();
    userSettings = await getUserSettings(currentUser.uid);

    customWorkHours = {};
    updateSidebarUser();
    await ensureTodayRecord();
    await loadRecords();
    closeModal('tenure-modal');
    showToast(`Tenure at ${company} ended — ${snap.size} records archived. Undo anytime in Companies.`, 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save & End Tenure';
  }
}
