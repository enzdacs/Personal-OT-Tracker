// =============================================
// dashboard.js — Main attendance tracking logic
// =============================================

const ROWS_PER_PAGE = 10;
let currentUser   = null;
let userSettings  = null;
let allRecords    = [];
let editingId     = null;
let currentPage   = 1;
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

  document.getElementById('btn-add-row').addEventListener('click', () => openAddModal());
  document.getElementById('btn-save-record').addEventListener('click', saveRecord);

  // Onboarding modal buttons
  document.getElementById('btn-ob-save').addEventListener('click', saveOnboarding);
  document.getElementById('btn-ob-later').addEventListener('click', () => {
    closeModal('onboarding-modal');
  });
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await auth.signOut();
    window.location.href = 'index.html';
  });

  // Auto-calc OT when timeout changes in add-modal
  document.getElementById('edit-timeout').addEventListener('input', recalcModalOT);
  document.getElementById('edit-date').addEventListener('change', recalcModalOT);
});

function updateSidebarUser() {
  const name     = userSettings.fullName || currentUser.email;
  const username = userSettings.username || name;
  const dept     = userSettings.department || 'Employee';
  document.getElementById('sidebar-username').textContent = name;
  document.getElementById('sidebar-dept').textContent     = dept;
  document.getElementById('sidebar-avatar').textContent   = getInitials(name);
  // Update greeting card
  const gHi   = document.getElementById('greeting-hi');
  const gName = document.getElementById('greeting-name');
  const gDept = document.getElementById('greeting-dept');
  if (gHi)   gHi.textContent   = 'Hi,';
  if (gName) gName.textContent = username;
  if (gDept) gDept.textContent = dept;
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
    await ref.set({
      date: today, timeOutStamp: null, timeOutDisplay: null,
      workMinutes: null, otMinutes: null, status: 'pending',
      otUsed: false, createdAt: firebase.firestore.FieldValue.serverTimestamp(), note: '',
    });
  }
}

// ── Load all records ─────────────────────────
async function loadRecords() {
  const snap = await db.collection('users').doc(currentUser.uid)
                       .collection('attendance').orderBy('date', 'desc').get();
  allRecords = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
        workMinutes: null, otMinutes: null, status: 'pending',
        otUsed: false, createdAt: firebase.firestore.FieldValue.serverTimestamp(), note: '',
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

// ── Render Table with Pagination ─────────────
function renderTable() {
  const tbody = document.getElementById('records-tbody');
  const today = getDateKey();
  if (!tbody) return;

  if (allRecords.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5">
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>No records yet. Your attendance will appear here daily.</p>
      </div></td></tr>`;
    renderPagination(0);
    return;
  }

  const totalPages = Math.ceil(allRecords.length / ROWS_PER_PAGE);
  if (currentPage > totalPages) currentPage = totalPages;
  const start    = (currentPage - 1) * ROWS_PER_PAGE;
  const pageRecs = allRecords.slice(start, start + ROWS_PER_PAGE);

  tbody.innerHTML = pageRecs.map(rec => {
    const isToday     = rec.id === today;
    const isAbsent    = rec.status === 'absent';
    const isHoliday   = rec.status === 'holiday';
    const isUsed      = rec.otUsed;
    const hasOT       = rec.otMinutes > 0;
    const notTimedOut = !rec.timeOutStamp && !isAbsent && !isHoliday;

    let rowClass = '';
    if (isAbsent)                    rowClass = 'row-absent';
    else if (isHoliday)              rowClass = 'row-holiday';
    else if (isUsed)                 rowClass = 'row-used';
    else if (isToday && notTimedOut) rowClass = 'row-today';
    else if (hasOT)                  rowClass = 'row-ot';

    // Time Out cell
    let timeOutCell;
    if (isHoliday) {
      timeOutCell = `<span class="badge badge-holiday">HOL</span>`;
    } else if (isAbsent) {
      timeOutCell = `<span class="badge badge-danger">ABS</span>`;
    } else if (rec.timeOutDisplay) {
      timeOutCell = `<span style="font-weight:600">${rec.timeOutDisplay}</span>`;
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

    // OT cell
    const otDisplay = (isAbsent || isHoliday) ? '—'
      : rec.otMinutes > 0
        ? `<span class="badge badge-warning">${minutesToHm(rec.otMinutes)}</span>`
        : '<span class="badge badge-gray">None</span>';

    // USE button
    const canUseOT = rec.otMinutes > 0 && !isAbsent && !isHoliday;
    const useBtn = canUseOT
      ? `<button class="btn btn-sm ${isUsed ? 'btn-success' : 'btn-primary'} btn-fixed-w"
           onclick="event.stopPropagation();toggleUse('${rec.id}')"
           title="${isUsed ? 'Click to undo use' : 'Use this OT'}">
           ${isUsed ? 'USED' : 'USE'}</button>`
      : `<span class="badge badge-gray" style="min-width:54px;justify-content:center">N/A</span>`;

    return `<tr class="${rowClass} row-clickable" onclick="viewRecord('${rec.id}')">
      <td>
        <div style="font-weight:600;font-size:.82rem">${formatDateShort(rec.date)}</div>
        <div style="font-size:.7rem;color:var(--text-light)">${dayName(rec.date)}</div>
      </td>
      <td>${timeOutCell}</td>
      <td>${workHoursCell}</td>
      <td>${otDisplay}</td>
      <td onclick="event.stopPropagation()">${useBtn}</td>
    </tr>`;
  }).join('');

  renderPagination(allRecords.length);
}

function renderPagination(total) {
  const bar = document.getElementById('pagination-bar');
  if (!bar) return;
  if (total === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';

  const totalPages = Math.ceil(total / ROWS_PER_PAGE);
  const start = Math.min((currentPage - 1) * ROWS_PER_PAGE + 1, total);
  const end   = Math.min(currentPage * ROWS_PER_PAGE, total);

  bar.innerHTML = `
    <div class="pagination-info">
      <span class="pag-full">Showing ${start}–${end} of ${total} records</span>
      <span class="pag-short">${start}–${end} of ${total}</span>
    </div>
    <div class="pagination-controls">
      <button class="btn btn-sm btn-ghost" onclick="goPage(1)" ${currentPage===1?'disabled':''}>«</button>
      <button class="btn btn-sm btn-ghost" onclick="goPage(${currentPage-1})" ${currentPage===1?'disabled':''}>
        <span class="pag-full">‹ Prev</span><span class="pag-short">&lt;</span>
      </button>
      <span style="font-size:.78rem;color:var(--text-light);padding:0 .25rem">Page ${currentPage} / ${totalPages}</span>
      <button class="btn btn-sm btn-ghost" onclick="goPage(${currentPage+1})" ${currentPage===totalPages?'disabled':''}>
        <span class="pag-full">Next ›</span><span class="pag-short">&gt;</span>
      </button>
      <button class="btn btn-sm btn-ghost" onclick="goPage(${totalPages})" ${currentPage===totalPages?'disabled':''}>»</button>
    </div>`;
}

function goPage(p) {
  const totalPages = Math.ceil(allRecords.length / ROWS_PER_PAGE);
  currentPage = Math.max(1, Math.min(p, totalPages));
  renderTable();
  const tw = document.querySelector('.table-wrap');
  if (tw) tw.scrollTop = 0;
}

// ── Stats ────────────────────────────────────
function renderStats() {
  const now      = getManilaDate();
  const prefix   = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const totalOT  = allRecords.filter(r => r.date.startsWith(prefix)).reduce((s, r) => s + (r.otMinutes || 0), 0);
  const usedOT   = allRecords.filter(r => r.otUsed).reduce((s, r) => s + (r.otMinutes || 0), 0);
  const allOT    = allRecords.reduce((s, r) => s + (r.otMinutes || 0), 0);
  const absences = allRecords.filter(r => r.status === 'absent').length;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stat-ot-month', minutesToHm(totalOT));
  set('stat-ot-used',  minutesToHm(usedOT));
  set('stat-ot-rem',   minutesToHm(allOT - usedOT));
  set('stat-absences', absences);
}

// ── Toggle OT Used ───────────────────────────
async function toggleUse(id) {
  const rec = allRecords.find(r => r.id === id);
  if (!rec) return;
  const newVal = !rec.otUsed;
  try {
    await db.collection('users').doc(currentUser.uid).collection('attendance').doc(id).update({ otUsed: newVal });
    showToast(newVal ? 'OT marked as Used ✓' : 'OT use undone', newVal ? 'success' : 'default');
    await loadRecords();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
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
  }
}

// ── VIEW mode ────────────────────────────────
function renderViewMode(rec, titleEl, bodyEl, footerEl) {
  const today = getDateKey();
  const isAbsent    = rec.status === 'absent';
  const isHoliday   = rec.status === 'holiday';
  const isPresent   = rec.status === 'present';
  const isPending   = rec.status === 'pending';
  const notTimedOut = !rec.timeOutStamp && !isAbsent && !isHoliday;
  const isToday     = rec.id === today;
  const { workStart, workEnd } = getEffectiveWorkHours(rec.id);

  titleEl.textContent = 'Record Details';

  const showStatusBtns = notTimedOut && isToday;

  const presentSection = `
    <div id="present-input-section" class="hidden" style="margin-top:.75rem;padding:.75rem;background:var(--primary-light);border-radius:8px;border:1px solid #BFDBFE">
      <label class="form-label" style="font-size:.78rem">Enter your Time Out:</label>
      <div style="display:flex;gap:.5rem;align-items:center;margin-top:.3rem">
        <input class="form-control" type="text" id="modal-timeout-input" placeholder="e.g. 5:30 PM" style="flex:1"/>
        <button class="btn btn-primary btn-sm" onclick="confirmPresentTimeout('${rec.id}')">Confirm</button>
      </div>
      <div class="form-hint">Format: 5:30 PM</div>
    </div>`;

  let statusBadge;
  if (isAbsent)       statusBadge = `<span class="badge badge-danger">Absent</span>`;
  else if (isHoliday) statusBadge = `<span class="badge badge-holiday">Holiday</span>`;
  else if (isPresent) statusBadge = `<span class="badge badge-success">Present</span>`;
  else                statusBadge = `<span class="badge badge-gray">Pending</span>`;

  let timeOutValue = rec.timeOutDisplay || '—';
  if (isAbsent)   timeOutValue = 'ABS';
  if (isHoliday)  timeOutValue = 'HOL';

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
        <span class="badge ${rec.otUsed?'badge-success':'badge-gray'}">${rec.otUsed?'Yes':'No'}</span>
      </div>
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
    <div class="form-group" id="em-timeout-group">
      <label class="form-label">Time Out</label>
      <input class="form-control" type="text" id="em-timeout" value="${rec.timeOutDisplay || ''}" placeholder="e.g. 5:30 PM" oninput="recalcEditModal()"/>
      <div class="form-hint">Format: 5:30 PM — Overtime is calculated automatically</div>
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
    </div>`;

  footerEl.innerHTML = `
    <button class="btn btn-ghost" onclick="cancelEditMode()">Cancel</button>
    <button class="btn btn-primary" onclick="saveEditFromModal()">Save Changes</button>`;

  // Apply initial status-based disable state
  setTimeout(() => handleEditStatusChange(), 0);
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
  const tout   = (document.getElementById('em-timeout')?.value || '').trim();
  const wStart = document.getElementById('em-work-start')?.value || getEffectiveWorkHours(modalRecordId).workStart;
  const wEnd   = document.getElementById('em-work-end')?.value   || getEffectiveWorkHours(modalRecordId).workEnd;

  const otEl   = document.getElementById('em-ot-display');
  const workEl = document.getElementById('em-work-display');
  if (!tout || !wStart || !wEnd) { if(otEl) otEl.textContent='—'; if(workEl) workEl.textContent='—'; return; }

  const parsed = parseTime12(tout);
  if (!parsed) { if(otEl) otEl.textContent='Invalid time'; return; }

  const s = timeInputToHm(wStart), e = timeInputToHm(wEnd);
  if (!s || !e) return;
  const base = new Date();
  const toMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0).getTime();
  const sMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), s.h, s.m, 0).getTime();
  const eMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();
  const workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000));
  const otMins   = Math.max(0, Math.round((toMs - eMs) / 60_000));
  if (workEl) workEl.textContent = minutesToHm(workMins);
  if (otEl)   otEl.textContent   = otMins > 0 ? minutesToHm(otMins) : 'None';
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
  const tout     = (dropStatus === 'present') ? (document.getElementById('em-timeout')?.value || '').trim() : '';
  const wStart   = document.getElementById('em-work-start')?.value || getEffectiveWorkHours(date).workStart;
  const wEnd     = document.getElementById('em-work-end')?.value   || getEffectiveWorkHours(date).workEnd;
  const note     = document.getElementById('em-note')?.value.trim() || '';

  let workMins = null, otMins = null, status = dropStatus;

  if (dropStatus === 'absent' || dropStatus === 'holiday') {
    workMins = 0; otMins = 0;
  } else {
    const parsed = tout ? parseTime12(tout) : null;
    if (parsed && wStart && wEnd) {
      const s = timeInputToHm(wStart), e = timeInputToHm(wEnd);
      const base = new Date();
      const toMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0).getTime();
      const sMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), s.h, s.m, 0).getTime();
      const eMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();
      workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000));
      otMins   = Math.max(0, Math.round((toMs - eMs) / 60_000));
    }
  }

  const parsed = (dropStatus === 'present' && tout) ? parseTime12(tout) : null;
  const defaultStart = userSettings.workStart || '08:00';
  const defaultEnd   = userSettings.workEnd   || '17:00';
  const isCustom     = (dropStatus === 'present') && (wStart !== defaultStart || wEnd !== defaultEnd);

  const data = {
    date, status, note,
    timeOutDisplay: (dropStatus==='present' && tout) ? tout : null,
    timeOutStamp: parsed ? firebase.firestore.Timestamp.fromDate(
      (() => { const d = getManilaDate(); d.setHours(parsed.h, parsed.m, 0, 0); return d; })()
    ) : null,
    workMinutes: workMins, otMinutes: otMins,
    customWorkStart: isCustom ? wStart : null,
    customWorkEnd:   isCustom ? wEnd   : null,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  if (isCustom) customWorkHours[date] = { workStart: wStart, workEnd: wEnd };
  else delete customWorkHours[date];

  const btn = document.querySelector('#record-modal-footer .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await db.collection('users').doc(currentUser.uid).collection('attendance').doc(date).update(data);
    showToast('Record modified ✓', 'success');
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
  const tout  = input ? input.value.trim() : '';
  if (!tout) { showToast('Please enter your Time Out time.', 'error'); return; }

  const parsed = parseTime12(tout);
  if (!parsed) { showToast('Invalid time format. Use e.g. 5:30 PM', 'error'); return; }

  const { workStart, workEnd } = getEffectiveWorkHours(id);
  const s = timeInputToHm(workStart), e = timeInputToHm(workEnd);
  const base = getManilaDate();
  const toMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0).getTime();
  const sMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), s.h, s.m, 0).getTime();
  const eMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();
  const workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000));
  const otMins   = Math.max(0, Math.round((toMs - eMs) / 60_000));

  try {
    await db.collection('users').doc(currentUser.uid).collection('attendance').doc(id)
            .update({
              status: 'present',
              timeOutDisplay: tout,
              timeOutStamp: firebase.firestore.Timestamp.fromDate(
                (() => { const d = getManilaDate(); d.setHours(parsed.h, parsed.m, 0, 0); return d; })()
              ),
              workMinutes: workMins,
              otMinutes: otMins,
            });
    showToast(`Time Out logged at ${tout}`, 'success');
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
  const tout   = document.getElementById('edit-timeout').value.trim();
  const wStart = document.getElementById('edit-work-start').value;
  const wEnd   = document.getElementById('edit-work-end').value;
  const otEl   = document.getElementById('edit-ot-display');
  const workEl = document.getElementById('edit-work-display');
  if (!tout || !wStart || !wEnd) { if(otEl) otEl.textContent='—'; if(workEl) workEl.textContent='—'; return; }
  const parsed = parseTime12(tout);
  if (!parsed) { if(otEl) otEl.textContent='Invalid time'; return; }
  const s = timeInputToHm(wStart), e = timeInputToHm(wEnd);
  if (!s || !e) return;
  const base = new Date();
  const toMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0).getTime();
  const sMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), s.h, s.m, 0).getTime();
  const eMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();
  const workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000));
  const otMins   = Math.max(0, Math.round((toMs - eMs) / 60_000));
  if (workEl) workEl.textContent = minutesToHm(workMins);
  if (otEl)   otEl.textContent   = otMins > 0 ? minutesToHm(otMins) : 'None';
}

async function saveRecord() {
  const date      = document.getElementById('edit-date').value;
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
    // present — calculate from time out
    const parsed = tout ? parseTime12(tout) : null;
    if (parsed && wStart && wEnd) {
      const s = timeInputToHm(wStart), e = timeInputToHm(wEnd);
      const base = new Date();
      const toMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0).getTime();
      const sMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), s.h, s.m, 0).getTime();
      const eMs   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), e.h, e.m, 0).getTime();
      workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000));
      otMins   = Math.max(0, Math.round((toMs - eMs) / 60_000));
    }
  }

  const parsed = (dropStatus === 'present' && tout) ? parseTime12(tout) : null;

  const defaultStart = userSettings.workStart || '08:00';
  const defaultEnd   = userSettings.workEnd   || '17:00';
  const isCustom     = (wStart !== defaultStart || wEnd !== defaultEnd);

  const data = {
    date,
    timeOutDisplay: (dropStatus === 'present' && tout) ? tout : null,
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
    await ref.set({ ...data, otUsed: false, createdAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    showToast('Record saved ✓', 'success');
    closeModal('add-modal');
    await loadRecords();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Record';
  }
}
