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
    else if (isOTLeave)              rowClass = 'row-ot-leave';
    else if (hasUsage)               rowClass = 'row-used';
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
    const otUseCell = hasUsage
      ? `<span class="badge badge-ot-leave" title="OT used as ${otUsageFullLabel(rec.otUsageType)}">${otUsageShortLabel(rec.otUsageType)}</span>`
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

// ── USE OT Modal ─────────────────────────────

function getRemainingOTMinutes() {
  return getOTPool(allRecords).remaining;
}

function getPendingUseDeductMins() {
  const type = document.getElementById('use-type')?.value;
  const wh   = getWorkdayHours();
  if (type === 'leave')   return Math.round(wh * 60);
  if (type === 'halfday') return Math.round((wh / 2) * 60); // always (Work Hours − Breaktime) / 2
  const h = parseFloat(document.getElementById('use-hours')?.value) || 0;
  return Math.round(h * 60);
}

// Live-checks the pending Use OT amount against remaining OT; disables Confirm + shows a warning if short
function validateUseForm() {
  const remOT   = getRemainingOTMinutes();
  const deduct  = getPendingUseDeductMins();
  const warning = document.getElementById('use-insufficient-warning');
  const warningText = document.getElementById('use-insufficient-warning-text');
  const btn     = document.getElementById('btn-confirm-use');
  const insufficient = deduct > 0 && deduct > remOT;
  if (warning) warning.classList.toggle('hidden', !insufficient);
  if (warningText && insufficient) {
    warningText.textContent = `You need ${minutesToHm(deduct)} but only have ${minutesToHm(remOT)} of OT available.`;
  }
  if (btn) btn.disabled = insufficient;
  return !insufficient;
}

function openUseModal() {
  if (userSettings.userType === 'intern') {
    showToast('OT usage is disabled for interns. Your OT hours are still being counted.', 'default');
    return;
  }
  const remOT = getRemainingOTMinutes();
  if (remOT <= 0) {
    showToast('No OT hours available to use.', 'default');
    return;
  }

  document.getElementById('use-modal-avail').textContent = minutesToHm(remOT);
  document.getElementById('use-leave-date').value        = getDateKey();
  document.getElementById('use-type').value              = 'leave';
  document.getElementById('use-timein').value            = userSettings.workStart || '08:00';
  document.getElementById('use-hours').value             = '';
  document.getElementById('use-note').value              = '';
  handleUseTypeChange();
  openModal('use-modal');
}

function handleUseTypeChange() {
  const type = document.getElementById('use-type')?.value;
  const hg   = document.getElementById('use-hours-group');
  const hint = document.getElementById('use-hours-hint');
  const timeInGroup = document.getElementById('use-timein-group');
  const minOutHint   = document.getElementById('use-min-timeout-hint');
  const wh   = getWorkdayHours(); // already (Work Start–End minus Breaktime Hours)

  if (type === 'leave') {
    if (hg) hg.style.display = 'none';
    if (timeInGroup) timeInGroup.style.display = 'none';
    if (minOutHint) minOutHint.classList.add('hidden');
  } else if (type === 'halfday') {
    // Half day is always (Work Hours − Breaktime) / 2 — no manual entry needed
    if (hg) hg.style.display = 'none';
    const hoursEl = document.getElementById('use-hours');
    if (hoursEl) hoursEl.value = (wh / 2).toFixed(2);
    if (timeInGroup) timeInGroup.style.display = 'block';
  } else {
    if (hg)   hg.style.display = 'block';
    if (hint) hint.textContent = 'Enter how many OT hours to deduct for undertime.';
    const hoursEl = document.getElementById('use-hours');
    if (hoursEl) hoursEl.value = '';
    if (timeInGroup) timeInGroup.style.display = 'block';
  }
  updateMinTimeOutHint();
  validateUseForm();
}

// Shows a live "minimum Time Out" hint for Half Day / Undertime, based on Time In + declared hours.
// Informational only — it doesn't block anything here; the actual warning happens later when the
// real Time Out for that day is logged (see recalcEditModal / confirmPresentTimeout).
function updateMinTimeOutHint() {
  const type = document.getElementById('use-type')?.value;
  const hintEl = document.getElementById('use-min-timeout-hint');
  if (!hintEl) return;
  if (type === 'leave') { hintEl.classList.add('hidden'); return; }

  const tin = document.getElementById('use-timein')?.value;
  const s = timeInputToHm(tin);
  if (!s) { hintEl.classList.add('hidden'); return; }

  const wh = getWorkdayHours();
  let minMins;
  if (type === 'halfday') {
    minMins = (s.h * 60 + s.m) + Math.round((wh / 2) * 60);
  } else {
    const h = parseFloat(document.getElementById('use-hours')?.value) || 0;
    const declaredMins = Math.round(h * 60);
    const expectedWorkMins = Math.max(0, Math.round(wh * 60) - declaredMins);
    minMins = (s.h * 60 + s.m) + getBreakMinutes() + expectedWorkMins;
  }
  hintEl.classList.remove('hidden');
  hintEl.textContent = `Based on this, your minimum Time Out that day is ${minutesToClockLabel(minMins)}.`;
}

async function confirmUseOT() {
  const type      = document.getElementById('use-type').value;
  const leaveDate = document.getElementById('use-leave-date').value;
  const note      = document.getElementById('use-note').value.trim();
  const tin       = document.getElementById('use-timein')?.value || userSettings.workStart || '08:00';
  const wh        = getWorkdayHours();

  let deductMins = 0;
  let usageLabel = '';
  if (type === 'leave') {
    deductMins = Math.round(wh * 60);
    usageLabel = 'FL-OT';
  } else if (type === 'halfday') {
    deductMins = Math.round((wh / 2) * 60); // always (Work Hours − Breaktime) / 2 — no manual entry
    usageLabel = 'HD-OT';
  } else {
    const h = parseFloat(document.getElementById('use-hours').value);
    if (!h || h <= 0) { showToast('Please enter hours to deduct.', 'error'); return; }
    deductMins = Math.round(h * 60);
    usageLabel = 'LATE-OT';
  }

  if (!leaveDate) { showToast('Please select a date.', 'error'); return; }

  const remOT = getRemainingOTMinutes();
  if (deductMins > remOT) {
    validateUseForm();
    showToast(`Insufficient OT — you need ${minutesToHm(deductMins)} but only have ${minutesToHm(remOT)} available.`, 'error');
    return;
  }

  const btn = document.getElementById('btn-confirm-use');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    // OT is pooled — usage doesn't draw from any one specific "source" day, it's just declared
    // against the total available. The transaction lives entirely on the leave-date record.
    const leaveRef = db.collection('users').doc(currentUser.uid).collection('attendance').doc(leaveDate);
    const leaveSnap = await leaveRef.get();

    if (usageLabel === 'FL-OT') {
      // No work happens that day — a flat credit, Time Out shows "N/A"
      const leaveData = {
        date: leaveDate, status: 'ot-leave',
        otUsageType: usageLabel, otUsageMins: deductMins, otUsageNote: note,
        timeInDisplay: null, timeOutStamp: null, timeOutDisplay: null,
        workMinutes: deductMins, otMinutes: 0,
      };
      if (!leaveSnap.exists) {
        await leaveRef.set({ ...leaveData, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      } else {
        await leaveRef.update(leaveData);
      }
    } else {
      // Half Day / Undertime — the person does work that day. Time In defaults to schedule
      // start (editable); Work Hours are computed from their actual logged Time Out once
      // entered, not fixed to the declared amount — the declared hours are just what's
      // subtracted from the OT pool, per the OT Counting Condition rule already applied
      // when that OT was originally earned.
      const inParsed = timeInputToHm(tin);
      const timeInDisplay = inParsed ? formatTime12(inParsed.h, inParsed.m) : null;
      const leaveData = {
        date: leaveDate, status: 'present',
        otUsageType: usageLabel, otUsageMins: deductMins, otUsageNote: note,
        timeInDisplay,
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
        else await leaveRef.update({ otUsageType: usageLabel, otUsageMins: deductMins, otUsageNote: note });
      }
    }

    showToast(`OT logged as ${otUsageShortLabel(usageLabel)} ✓`, 'success');
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
  titleEl.textContent = 'Undo OT Usage';
  const label = otUsageShortLabel(rec.otUsageType);
  bodyEl.innerHTML = `
    <p style="font-size:.88rem;color:var(--text)">
      Undo this ${label} usage for <strong>${formatDateLong(rec.date)}</strong>?
      ${rec.otUsageType === 'FL-OT'
        ? ' This record will be removed since no work was logged that day.'
        : ' The day keeps its logged attendance — only the OT usage will be removed.'}
      Your OT hours will be restored.
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
    if (rec.otUsageType === 'FL-OT') {
      // Full-day leave placeholder — nothing was actually worked, so remove it entirely
      await ref.delete();
      showToast('OT usage undone — leave day removed.', 'default');
    } else {
      // Half Day / Undertime — keep the real attendance logged that day, just drop the usage
      await ref.update({
        otUsageType: firebase.firestore.FieldValue.delete(),
        otUsageMins: firebase.firestore.FieldValue.delete(),
        otUsageNote: firebase.firestore.FieldValue.delete(),
        otUsageDate: firebase.firestore.FieldValue.delete(),
        otSourceId:  firebase.firestore.FieldValue.delete(),
      });
      showToast('OT usage undone.', 'default');
    }
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
    if (activeFilters.otUse === 'used'    && !r.otUsageType)         return false;
    if (activeFilters.otUse === 'unused'  && r.otUsageType)          return false;
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
        <span class="badge ${rec.otUsageType?'badge-success':'badge-gray'}">${rec.otUsageType ? `Yes (${formatDateShort(rec.date)})` : 'No'}</span>
      </div>
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
    ${rec.otUsageType ? `<button class="btn btn-ghost" onclick="setModalMode('confirm-undo')">↩ Undo OT Usage</button>` : ''}
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
      <span>⚠️</span><span>You timed out before your work hours end. Use OT hours if you have any undertime.</span>
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
    ${rec.otUsageType ? `
    <div class="form-group" style="background:var(--bg);border-radius:8px;padding:.85rem;border:1px solid var(--border)">
      <div style="font-size:.78rem;font-weight:700;color:var(--text);margin-bottom:.6rem">OT Usage</div>
      <div class="form-group" style="margin-bottom:.6rem">
        <label class="form-label" style="font-size:.78rem">Usage Type</label>
        <select class="form-control" id="em-usage-type" onchange="handleEditUsageTypeChange()">
          <option value="FL-OT"   ${rec.otUsageType==='FL-OT'  ?'selected':''}>Full Day Leave (FL-OT)</option>
          <option value="HD-OT"   ${rec.otUsageType==='HD-OT'  ?'selected':''}>Half Day (HD-OT)</option>
          <option value="LATE-OT" ${rec.otUsageType==='LATE-OT'?'selected':''}>Undertime (UT-OT)</option>
        </select>
      </div>
      <div class="form-group hidden" id="em-usage-hours-group" style="margin-bottom:.4rem">
        <label class="form-label" style="font-size:.78rem">Hours to Deduct</label>
        <input class="form-control" type="number" id="em-usage-hours" min="0.25" step="0.25"
               value="${((rec.otUsageMins||0)/60).toFixed(2)}" oninput="handleEditUsageTypeChange()"/>
      </div>
      <div class="hidden" id="em-usage-insufficient-warning" style="display:flex;gap:.5rem;align-items:flex-start;background:#FEF2F2;border:1px solid #FCA5A5;color:#B91C1C;border-radius:8px;padding:.5rem .65rem;font-size:.76rem;margin-top:.3rem">
        <span>⚠️</span><span id="em-usage-insufficient-warning-text"></span>
      </div>
    </div>` : ''}`;

  footerEl.innerHTML = `
    <button class="btn btn-ghost" onclick="cancelEditMode()">Cancel</button>
    <button class="btn btn-primary" onclick="saveEditFromModal()">Save Changes</button>`;

  // Apply initial status-based disable state
  setTimeout(() => { handleEditStatusChange(); handleEditUsageTypeChange(); }, 0);
}

// Live-checks a pending OT-usage-type edit against remaining OT (excluding this record's own
// currently-declared amount, since we're changing it, not adding a new usage on top of it)
function handleEditUsageTypeChange() {
  const typeEl = document.getElementById('em-usage-type');
  if (!typeEl) return; // record has no otUsageType — nothing to edit
  const type = typeEl.value;
  const hg   = document.getElementById('em-usage-hours-group');
  const wh   = getWorkdayHours();

  let deductMins;
  if (type === 'FL-OT') {
    if (hg) hg.style.display = 'none';
    deductMins = Math.round(wh * 60);
  } else if (type === 'HD-OT') {
    if (hg) hg.style.display = 'none';
    deductMins = Math.round((wh / 2) * 60);
  } else {
    if (hg) hg.style.display = 'block';
    const h = parseFloat(document.getElementById('em-usage-hours')?.value) || 0;
    deductMins = Math.round(h * 60);
  }

  const rec = allRecords.find(r => r.id === modalRecordId);
  const remOTExcludingThis = getRemainingOTMinutesExcluding(rec ? rec.id : null);
  const warning = document.getElementById('em-usage-insufficient-warning');
  const warningText = document.getElementById('em-usage-insufficient-warning-text');
  const insufficient = deductMins > 0 && deductMins > remOTExcludingThis;
  if (warning) warning.classList.toggle('hidden', !insufficient);
  if (warningText && insufficient) {
    warningText.textContent = `You need ${minutesToHm(deductMins)} but only have ${minutesToHm(remOTExcludingThis)} of OT available.`;
  }
  const saveBtn = document.querySelector('#record-modal-footer .btn-primary');
  if (saveBtn) saveBtn.disabled = insufficient;
  return { type, deductMins, insufficient };
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
      const label = rec.otUsageType === 'HD-OT' ? 'half day' : 'undertime';
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
  return (toutHm.h * 60 + toutHm.m) < (workEndHm.h * 60 + workEndHm.m);
}

// For a Half Day / Undertime OT-usage record, computes the minimum valid Time Out given a Time In —
// used to softly warn (never block) if the logged Time Out falls short of what was declared.
function computeMinTimeOutForUsage(rec, tinHm) {
  if (!rec || !rec.otUsageType || rec.otUsageType === 'FL-OT' || !tinHm) return null;
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
  if (document.getElementById('em-usage-type')) {
    const result = handleEditUsageTypeChange();
    if (result && result.insufficient) {
      showToast(`Insufficient OT for this usage type — you need ${minutesToHm(result.deductMins)}.`, 'error');
      return;
    }
    if (result) {
      usageUpdate = { otUsageType: result.type, otUsageMins: result.deductMins };
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

  const btn = document.querySelector('#record-modal-footer .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await db.collection('users').doc(currentUser.uid).collection('attendance').doc(date).update(data);
    showToast('Record modified ✓', 'success');
    const hasUsage = !!(usageUpdate ? usageUpdate.otUsageType : rec.otUsageType);
    if (dropStatus === 'present' && !hasUsage && isEarlyCheckoutWithoutOT(parsed, timeInputToHm(wEnd))) {
      showToast('⚠ You timed out before your work hours end. Use OT hours if you have any undertime.', 'default');
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
    await db.collection('users').doc(currentUser.uid).collection('attendance').doc(id).delete();
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
      const label = rec.otUsageType === 'HD-OT' ? 'half day' : 'undertime';
      showToast(`⚠ You checked out earlier than your declared ${label} accounts for (minimum: ${minutesToClockLabel(minMins)}).`, 'default');
    } else if ((!rec || !rec.otUsageType) && isEarlyCheckoutWithoutOT(parsed, e)) {
      showToast('⚠ You timed out before your work hours end. Use OT hours if you have any undertime.', 'default');
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
      showToast('⚠ You timed out before your work hours end. Use OT hours if you have any undertime.', 'default');
    }
    closeModal('add-modal');
    await loadRecords();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Record';
  }
}
