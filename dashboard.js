// =============================================
// dashboard.js — Main attendance tracking logic
// =============================================

const ROWS_PER_PAGE = 10;
let currentUser   = null;
let userSettings  = null;
let allRecords    = [];
let otInterval    = null;
let editingId     = null;
let currentPage   = 1;
// Per-record custom work hours override: { [dateKey]: { workStart, workEnd } }
let customWorkHours = {};

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
    startOTWatcher();
    startAbsenceWatcher();
    hideLoader();
  });

  // Modal close
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  document.getElementById('btn-add-row').addEventListener('click', () => openAddModal());
  document.getElementById('btn-save-record').addEventListener('click', saveRecord);
  document.getElementById('btn-confirm-delete').addEventListener('click', confirmDelete);
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await auth.signOut();
    window.location.href = 'index.html';
  });

  // Auto-calc OT when timeout changes in modal
  document.getElementById('edit-timeout').addEventListener('input', recalcModalOT);
  document.getElementById('edit-date').addEventListener('change', recalcModalOT);
});

function updateSidebarUser() {
  const name = userSettings.fullName || currentUser.email;
  document.getElementById('sidebar-username').textContent = name;
  document.getElementById('sidebar-dept').textContent     = userSettings.department || 'Employee';
  document.getElementById('sidebar-avatar').textContent   = getInitials(name);
}

// ── Get effective work hours for a date ──────
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
  // Load custom work hours from records that have them stored
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

// ── Real-time OT watcher ─────────────────────
function startOTWatcher() {
  if (otInterval) clearInterval(otInterval);
  otInterval = setInterval(checkOT, 1000);
}

function checkOT() {
  const today  = getDateKey();
  const rec    = allRecords.find(r => r.id === today);
  const banner = document.getElementById('ot-banner');
  const timerEl = document.getElementById('ot-timer');

  if (!rec || rec.status === 'absent' || rec.timeOutStamp) {
    if (banner) banner.classList.add('hidden');
    return;
  }

  const now = getManilaDate();
  const { workEnd } = getEffectiveWorkHours(today);
  const end = timeInputToHm(workEnd);
  if (!end) return;

  const workEndMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), end.h, end.m, 0, 0).getTime();
  const grace     = (userSettings.gracePeriod || 0) * 60_000;
  const nowMs     = now.getTime();

  if (nowMs > workEndMs + grace) {
    const otMs   = nowMs - workEndMs;
    const otSecs = Math.floor(otMs / 1000);
    const h = Math.floor(otSecs / 3600);
    const m = Math.floor((otSecs % 3600) / 60);
    const s = otSecs % 60;
    const str = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if (banner) banner.classList.remove('hidden');
    if (timerEl) timerEl.textContent = str;
    const otCell = document.getElementById(`ot-live-${today}`);
    if (otCell) otCell.textContent = `${h}h ${m}m`;
  } else {
    if (banner) banner.classList.add('hidden');
  }
}

// ── Absence watcher: mark absent at 11 PM if no time out ──
function startAbsenceWatcher() {
  setInterval(async () => {
    const today  = getDateKey();
    const rec    = allRecords.find(r => r.id === today);
    if (!rec || rec.status !== 'pending' || rec.timeOutStamp) return;
    const now    = getManilaDate();
    if (now.getHours() >= 23) {
      // Mark absent automatically
      try {
        await db.collection('users').doc(currentUser.uid)
                .collection('attendance').doc(today)
                .update({ status: 'absent', workMinutes: 0, otMinutes: 0 });
        await loadRecords();
      } catch(e) {}
    }
  }, 60_000); // check every minute
}

// ── Date format helpers ───────────────────────
function formatDateShort(dateKey) {
  // "YYYY-MM-DD" → "MM/DD/YYYY"
  const [y, mo, d] = dateKey.split('-');
  return `${mo}/${d}/${y}`;
}

function formatDateLong(dateKey) {
  // "YYYY-MM-DD" → "Monday, April 13, 2026"
  const [y, mo, d] = dateKey.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  return date.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ── Row click → view modal (ignores button clicks) ──
function rowClick(event, id) {
  // Don't open modal if user clicked a button/interactive element inside the row
  if (event.target.closest('button, .dropdown-wrap')) return;
  viewRecord(id);
}

// ── Dropdown helpers ──────────────────────────
function toggleDropdown(event, id) {
  event.stopPropagation();
  const menu = document.getElementById(`dd-${id}`);
  const isOpen = !menu.classList.contains('hidden');
  closeAllDropdowns();
  if (!isOpen) {
    menu.classList.remove('hidden');
    // Position check: flip up if near bottom of viewport
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 20) {
      menu.style.top = 'auto';
      menu.style.bottom = '100%';
    }
  }
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
}

// Close dropdowns when clicking outside
document.addEventListener('click', closeAllDropdowns);

// ── Render Table with Pagination ─────────────
function renderTable() {
  const tbody    = document.getElementById('records-tbody');
  const today    = getDateKey();
  if (!tbody) return;

  if (allRecords.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>No records yet. Your attendance will appear here daily.</p>
      </div></td></tr>`;
    renderPagination(0);
    return;
  }

  const totalPages = Math.ceil(allRecords.length / ROWS_PER_PAGE);
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * ROWS_PER_PAGE;
  const pageRecs = allRecords.slice(start, start + ROWS_PER_PAGE);

  tbody.innerHTML = pageRecs.map(rec => {
    const isToday     = rec.id === today;
    const isAbsent    = rec.status === 'absent';
    const isUsed      = rec.otUsed;
    const hasOT       = rec.otMinutes > 0;
    const notTimedOut = !rec.timeOutStamp && !isAbsent;

    let rowClass = '';
    if (isAbsent)                         rowClass = 'row-absent';
    else if (isUsed)                      rowClass = 'row-used';
    else if (isToday && notTimedOut)      rowClass = 'row-today';
    else if (hasOT)                       rowClass = 'row-ot';

    // Time Out column — auto ABS logic
    let timeOutCell;
    if (isAbsent) {
      timeOutCell = `<span class="badge badge-danger">ABS</span>`;
    } else if (rec.timeOutDisplay) {
      timeOutCell = `<span style="font-weight:600">${rec.timeOutDisplay}</span>`;
    } else if (notTimedOut && isToday) {
      timeOutCell = `<span class="badge badge-warning">Pending</span>`;
    } else if (notTimedOut && !isToday) {
      // Past day, no timeout, auto-absent (should not normally show pending)
      timeOutCell = `<span class="badge badge-danger">ABS</span>`;
    } else {
      timeOutCell = '—';
    }

    // Work Hours column — shows range from settings (or custom)
    const { workStart, workEnd } = getEffectiveWorkHours(rec.id);
    const hasCustom = !!(rec.customWorkStart || rec.customWorkEnd);
    const workHoursCell = `
      <div style="line-height:1.3">
        <div class="work-hrs-range">${formatWorkRange(workStart, workEnd)}</div>
        ${rec.workMinutes != null ? `<div style="font-size:.7rem;color:var(--text-light)">${minutesToHm(rec.workMinutes)} worked</div>` : ''}
      </div>`;

    // OT cell
    const otDisplay = isAbsent ? '—'
      : rec.otMinutes > 0
        ? `<span class="badge badge-warning">${minutesToHm(rec.otMinutes)}</span>`
        : (notTimedOut && isToday
          ? `<span id="ot-live-${rec.id}" class="badge badge-gray">—</span>`
          : '<span class="badge badge-gray">None</span>');

    // USE button
    const canUseOT = rec.otMinutes > 0 && !isAbsent;
    const useBtn = canUseOT
      ? `<button class="btn btn-sm ${isUsed ? 'btn-success' : 'btn-primary'}"
           onclick="toggleUse('${rec.id}')" title="${isUsed ? 'Click to undo use' : 'Use this OT'}">
           ${isUsed ? '✓ USED' : 'USE'}</button>`
      : `<span class="badge badge-gray">N/A</span>`;

    // Time Out button
    const timeOutBtn = (notTimedOut)
      ? `<button class="btn btn-sm btn-danger" onclick="doTimeOut('${rec.id}')">⏱ Time Out</button>`
      : (rec.timeOutDisplay ? `<span class="badge badge-success">Done</span>` : '');

    // Absent button
    const absentBtn = isAbsent
      ? `<span class="badge badge-danger">Absent</span>`
      : (!rec.timeOutStamp
          ? `<button class="btn btn-sm btn-ghost" onclick="markAbsent('${rec.id}')">Absent</button>`
          : '');

    return `<tr class="${rowClass} row-clickable" onclick="rowClick(event,'${rec.id}')">
      <td>
        <div style="font-weight:600;font-size:.82rem">${formatDateShort(rec.date)}</div>
        <div style="font-size:.7rem;color:var(--text-light)">${dayName(rec.date)}</div>
      </td>
      <td>${timeOutCell}</td>
      <td>${workHoursCell}</td>
      <td>${otDisplay}</td>
      <td onclick="event.stopPropagation()">${useBtn}</td>
      <td onclick="event.stopPropagation()" class="more-cell">
        <div class="dropdown-wrap">
          <button class="btn btn-sm btn-ghost btn-icon dropdown-trigger" onclick="toggleDropdown(event,'${rec.id}')" title="More options">⋯</button>
          <div class="dropdown-menu hidden" id="dd-${rec.id}">
            ${notTimedOut ? `<button class="dropdown-item" onclick="closeAllDropdowns();doTimeOut('${rec.id}')">⏱ Time Out</button>` : ''}
            ${(!rec.timeOutStamp && !isAbsent) ? `<button class="dropdown-item" onclick="closeAllDropdowns();markAbsent('${rec.id}')">✗ Mark Absent</button>` : ''}
            <button class="dropdown-item" onclick="closeAllDropdowns();editRecord('${rec.id}')">✏️ Edit</button>
            <button class="dropdown-item dropdown-item-danger" onclick="closeAllDropdowns();deleteRecord('${rec.id}')">🗑 Delete</button>
          </div>
        </div>
      </td>
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
    <div class="pagination-info">Showing ${start}–${end} of ${total} records</div>
    <div class="pagination-controls">
      <button class="btn btn-sm btn-ghost" onclick="goPage(1)" ${currentPage===1?'disabled':''}>«</button>
      <button class="btn btn-sm btn-ghost" onclick="goPage(${currentPage-1})" ${currentPage===1?'disabled':''}>‹ Prev</button>
      <span style="font-size:.78rem;color:var(--text-light);padding:0 .25rem">Page ${currentPage} / ${totalPages}</span>
      <button class="btn btn-sm btn-ghost" onclick="goPage(${currentPage+1})" ${currentPage===totalPages?'disabled':''}>Next ›</button>
      <button class="btn btn-sm btn-ghost" onclick="goPage(${totalPages})" ${currentPage===totalPages?'disabled':''}>»</button>
    </div>`;
}

function goPage(p) {
  const totalPages = Math.ceil(allRecords.length / ROWS_PER_PAGE);
  currentPage = Math.max(1, Math.min(p, totalPages));
  renderTable();
  // Scroll table to top
  const tw = document.querySelector('.table-wrap');
  if (tw) tw.scrollTop = 0;
}

// ── Stats ────────────────────────────────────
function renderStats() {
  const now     = getManilaDate();
  const prefix  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const totalOT = allRecords.filter(r => r.date.startsWith(prefix)).reduce((s, r) => s + (r.otMinutes || 0), 0);
  const usedOT  = allRecords.filter(r => r.otUsed).reduce((s, r) => s + (r.otMinutes || 0), 0);
  const allOT   = allRecords.reduce((s, r) => s + (r.otMinutes || 0), 0);
  const absences = allRecords.filter(r => r.status === 'absent').length;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stat-ot-month', minutesToHm(totalOT));
  set('stat-ot-used',  minutesToHm(usedOT));
  set('stat-ot-rem',   minutesToHm(allOT - usedOT));
  set('stat-absences', absences);
}

// ── Time Out ────────────────────────────────
async function doTimeOut(id) {
  const now = getManilaDate();
  const { workStart, workEnd } = getEffectiveWorkHours(id);
  const start = timeInputToHm(workStart);
  const end   = timeInputToHm(workEnd);

  const workStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), start.h, start.m, 0).getTime();
  const workEndMs   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), end.h,   end.m,   0).getTime();
  const nowMs       = now.getTime();

  let workMins = Math.round((Math.min(nowMs, workEndMs) - workStartMs) / 60_000);
  if (workMins < 0) workMins = 0;
  let otMins = Math.round((nowMs - workEndMs) / 60_000);
  if (otMins < 0) otMins = 0;

  const timeOutDisplay = formatTime12(now.getHours(), now.getMinutes());

  try {
    await db.collection('users').doc(currentUser.uid)
            .collection('attendance').doc(id)
            .update({
              timeOutStamp: firebase.firestore.Timestamp.fromDate(now),
              timeOutDisplay, workMinutes: workMins, otMinutes: otMins, status: 'present',
            });
    showToast(`Time Out recorded at ${timeOutDisplay}`, 'success');
    await loadRecords();
  } catch(e) {
    showToast('Failed to record time out. ' + e.message, 'error');
  }
}

// ── Mark Absent ──────────────────────────────
async function markAbsent(id) {
  if (!confirm('Mark this day as Absent?')) return;
  try {
    await db.collection('users').doc(currentUser.uid)
            .collection('attendance').doc(id)
            .update({ status: 'absent', timeOutStamp: null, timeOutDisplay: null, workMinutes: 0, otMinutes: 0 });
    showToast('Marked as Absent', 'warning');
    await loadRecords();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
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

// ── View Record ──────────────────────────────
function viewRecord(id) {
  const rec = allRecords.find(r => r.id === id);
  if (!rec) return;
  const { workStart, workEnd } = getEffectiveWorkHours(id);
  const body = document.getElementById('view-modal-body');
  body.innerHTML = `
    <div style="display:grid;gap:.65rem">
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Date</span>
        <strong>${formatDateLong(rec.date)}</strong>
      </div>
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Status</span>
        <span class="badge ${rec.status==='absent'?'badge-danger':rec.status==='present'?'badge-success':'badge-gray'}">${rec.status}</span>
      </div>
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Work Schedule</span>
        <strong>${formatWorkRange(workStart, workEnd)}</strong>
      </div>
      <div class="flex justify-between items-center">
        <span class="text-sm" style="color:var(--text-light)">Time Out</span>
        <strong>${rec.timeOutDisplay || '—'}</strong>
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
      ${rec.note ? `<div style="margin-top:.5rem;padding:.6rem .8rem;background:var(--bg);border-radius:7px;font-size:.82rem">${rec.note}</div>` : ''}
    </div>`;
  openModal('view-modal');
}

// ── Edit Record ──────────────────────────────
function editRecord(id) {
  const rec = allRecords.find(r => r.id === id);
  if (!rec) return;
  editingId = id;

  const { workStart, workEnd } = getEffectiveWorkHours(id);
  document.getElementById('edit-date').value          = rec.date;
  document.getElementById('edit-timeout').value       = rec.timeOutDisplay || '';
  document.getElementById('edit-note').value          = rec.note || '';
  document.getElementById('edit-work-start').value    = workStart;
  document.getElementById('edit-work-end').value      = workEnd;
  document.getElementById('edit-ot-display').textContent = rec.otMinutes != null ? minutesToHm(rec.otMinutes) : '—';
  document.getElementById('edit-work-display').textContent = rec.workMinutes != null ? minutesToHm(rec.workMinutes) : '—';

  document.getElementById('modal-title').textContent = 'Edit Record';
  openModal('add-modal');
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

  document.getElementById('modal-title').textContent = 'Add Record';
  openModal('add-modal');
}

// Open custom hours editor inside modal
function openWorkHoursEditor() {
  const wrap = document.getElementById('work-hours-editor');
  if (wrap) wrap.classList.toggle('hidden');
}

// Recalculate OT when timeout changes in modal
function recalcModalOT() {
  const tout   = document.getElementById('edit-timeout').value.trim();
  const wStart = document.getElementById('edit-work-start').value;
  const wEnd   = document.getElementById('edit-work-end').value;

  const otEl   = document.getElementById('edit-ot-display');
  const workEl = document.getElementById('edit-work-display');

  if (!tout || !wStart || !wEnd) {
    if (otEl)   otEl.textContent   = '—';
    if (workEl) workEl.textContent = '—';
    return;
  }

  const parsed = parseTime12(tout);
  if (!parsed) {
    if (otEl) otEl.textContent = 'Invalid time';
    return;
  }

  const s = timeInputToHm(wStart);
  const e = timeInputToHm(wEnd);
  if (!s || !e) return;

  // Use today's date as placeholder for calculation
  const baseDate = new Date();
  const toMs   = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), parsed.h, parsed.m, 0).getTime();
  const sMs    = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), s.h, s.m, 0).getTime();
  const eMs    = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), e.h, e.m, 0).getTime();

  let workMins = Math.round((Math.min(toMs, eMs) - sMs) / 60_000);
  if (workMins < 0) workMins = 0;
  let otMins = Math.round((toMs - eMs) / 60_000);
  if (otMins < 0) otMins = 0;

  if (workEl) workEl.textContent = minutesToHm(workMins);
  if (otEl)   otEl.textContent   = otMins > 0 ? minutesToHm(otMins) : 'None';
}

// ── Save Record (Add/Edit) ───────────────────
async function saveRecord() {
  const date    = document.getElementById('edit-date').value;
  const tout    = document.getElementById('edit-timeout').value.trim();
  const wStart  = document.getElementById('edit-work-start').value;
  const wEnd    = document.getElementById('edit-work-end').value;
  const note    = document.getElementById('edit-note').value.trim();

  if (!date) { showToast('Date is required.', 'error'); return; }

  const parsed = tout ? parseTime12(tout) : null;

  let workMins = null, otMins = null;
  let status = 'pending';

  if (parsed && wStart && wEnd) {
    const s = timeInputToHm(wStart);
    const e = timeInputToHm(wEnd);
    const baseDate = new Date();
    const toMs  = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), parsed.h, parsed.m, 0).getTime();
    const sMs   = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), s.h, s.m, 0).getTime();
    const eMs   = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), e.h, e.m, 0).getTime();
    workMins = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000));
    otMins   = Math.max(0, Math.round((toMs - eMs) / 60_000));
    status   = 'present';
  }

  // Determine if custom work hours differ from settings
  const defaultStart = userSettings.workStart || '08:00';
  const defaultEnd   = userSettings.workEnd   || '17:00';
  const isCustom     = (wStart !== defaultStart || wEnd !== defaultEnd);

  const data = {
    date,
    timeOutDisplay: tout || null,
    timeOutStamp:   tout && parsed ? firebase.firestore.Timestamp.fromDate(
      (() => { const d = getManilaDate(); d.setHours(parsed.h, parsed.m, 0, 0); return d; })()
    ) : null,
    workMinutes:    workMins,
    otMinutes:      otMins,
    status,
    note,
    customWorkStart: isCustom ? wStart : null,
    customWorkEnd:   isCustom ? wEnd   : null,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  // Update local custom work hours cache
  if (isCustom) {
    customWorkHours[date] = { workStart: wStart, workEnd: wEnd };
  } else {
    delete customWorkHours[date];
  }

  const btn = document.getElementById('btn-save-record');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const ref = db.collection('users').doc(currentUser.uid).collection('attendance').doc(date);
    if (editingId) {
      await ref.update(data);
    } else {
      await ref.set({ ...data, otUsed: false, createdAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    showToast('Record saved ✓', 'success');
    closeModal('add-modal');
    await loadRecords();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Record';
  }
}

// ── Delete Record ────────────────────────────
let pendingDeleteId = null;
function deleteRecord(id) {
  pendingDeleteId = id;
  const rec = allRecords.find(r => r.id === id);
  document.getElementById('delete-info').textContent = rec ? formatDate(rec.date) : id;
  openModal('delete-modal');
}
async function confirmDelete() {
  if (!pendingDeleteId) return;
  try {
    await db.collection('users').doc(currentUser.uid)
            .collection('attendance').doc(pendingDeleteId).delete();
    delete customWorkHours[pendingDeleteId];
    showToast('Record deleted.', 'default');
    closeModal('delete-modal');
    await loadRecords();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
  pendingDeleteId = null;
}
