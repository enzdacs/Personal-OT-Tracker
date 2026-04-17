// =============================================
// schedule.js — Work Schedule page logic
// =============================================

let currentUser  = null;
let userSettings = null;

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

document.addEventListener('DOMContentLoaded', () => {
  showLoader();
  requireAuth(async user => {
    currentUser  = user;
    userSettings = await getUserSettings(user.uid);
    updateSidebarUser();
    initSidebar();
    startLiveClock(document.getElementById('clock-time'), document.getElementById('clock-date'));
    populateScheduleForm();
    initNotifications(user, userSettings);
    hideLoader();
  });

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay.id); });
  });

  document.getElementById('btn-save-schedule').addEventListener('click', saveSchedule);
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await auth.signOut(); window.location.href = 'index.html';
  });

  // Auto-update OT-to-leave and preview when times change
  document.addEventListener('input', e => {
    if (e.target.id === 's-work-start' || e.target.id === 's-work-end') {
      updateWorkHoursPreview();
      updateOTLeaveComputed();
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 's-work-start' || e.target.id === 's-work-end') {
      updateWorkHoursPreview();
      updateOTLeaveComputed();
    }
  });
});

function updateSidebarUser() {
  const name = userSettings.fullName || currentUser.email;
  document.getElementById('sidebar-username').textContent = name;
  document.getElementById('sidebar-dept').textContent     = userSettings.department || 'Employee';
  document.getElementById('sidebar-avatar').textContent   = getInitials(name);
}

function populateScheduleForm() {
  const s = userSettings;
  document.getElementById('s-work-start').value = s.workStart || '08:00';
  document.getElementById('s-work-end').value   = s.workEnd   || '17:00';

  const workDays = s.workDays || [1,2,3,4,5];
  document.querySelectorAll('.day-check').forEach(cb => {
    cb.checked = workDays.includes(parseInt(cb.value));
  });

  const isMulti = s.multiSchedule || false;
  document.getElementById('s-multi-schedule').checked = isMulti;
  buildPerDayRows(workDays, s.perDaySchedule || {});
  handleMultiScheduleToggle();
  updateWorkHoursPreview();
  updateOTLeaveComputed();
}

function buildPerDayRows(workDays, perDaySchedule) {
  const container = document.getElementById('per-day-schedule-rows');
  if (!container) return;
  container.innerHTML = '';
  workDays.forEach(dayIdx => {
    const saved = perDaySchedule[dayIdx] || {};
    const start = saved.start || '08:00';
    const end   = saved.end   || '17:00';
    const row = document.createElement('div');
    row.dataset.day = dayIdx;
    row.style.cssText = 'display:grid;grid-template-columns:80px 1fr 1fr;gap:.5rem;align-items:center;margin-bottom:.6rem';
    row.innerHTML = `
      <span style="font-size:.82rem;font-weight:600;color:var(--text)">${DAY_NAMES[dayIdx].substring(0,3)}</span>
      <input class="form-control" type="time" id="pd-start-${dayIdx}" value="${start}" style="font-size:.82rem"/>
      <input class="form-control" type="time" id="pd-end-${dayIdx}"   value="${end}"   style="font-size:.82rem"/>`;
    container.appendChild(row);
  });
}

function handleMultiScheduleToggle() {
  const isMulti = document.getElementById('s-multi-schedule')?.checked;
  document.getElementById('single-schedule-block')?.classList.toggle('hidden', isMulti);
  document.getElementById('multi-schedule-block')?.classList.toggle('hidden', !isMulti);
  if (isMulti) {
    const days = [];
    document.querySelectorAll('.day-check:checked').forEach(cb => days.push(parseInt(cb.value)));
    const perDay = userSettings.perDaySchedule || {};
    buildPerDayRows(days.sort(), perDay);
  }
}

function onWorkDayChange() {
  const isMulti = document.getElementById('s-multi-schedule')?.checked;
  if (!isMulti) return;
  const currentRows = {};
  document.querySelectorAll('#per-day-schedule-rows [data-day]').forEach(row => {
    const d = parseInt(row.dataset.day);
    const s = document.getElementById(`pd-start-${d}`)?.value;
    const e = document.getElementById(`pd-end-${d}`)?.value;
    if (s && e) currentRows[d] = { start: s, end: e };
  });
  const days = [];
  document.querySelectorAll('.day-check:checked').forEach(cb => days.push(parseInt(cb.value)));
  const merged = { ...(userSettings.perDaySchedule || {}), ...currentRows };
  buildPerDayRows(days.sort(), merged);
}

function updateWorkHoursPreview() {
  const start = timeInputToHm(document.getElementById('s-work-start')?.value);
  const end   = timeInputToHm(document.getElementById('s-work-end')?.value);
  const el    = document.getElementById('work-hours-preview');
  if (!start || !end || !el) return;
  const mins = (end.h * 60 + end.m) - (start.h * 60 + start.m);
  el.textContent = mins > 0 ? `= ${minutesToHm(mins)} of work per day` : 'Invalid range';
}

function updateOTLeaveComputed() {
  const start = timeInputToHm(document.getElementById('s-work-start')?.value);
  const end   = timeInputToHm(document.getElementById('s-work-end')?.value);
  const el    = document.getElementById('ot-leave-computed');
  if (!el) return;
  if (!start || !end) { el.textContent = '—'; return; }
  const mins  = (end.h * 60 + end.m) - (start.h * 60 + start.m);
  if (mins <= 0) { el.textContent = '—'; return; }
  const hours = Math.round(mins / 60 * 10) / 10;
  el.textContent = `${hours}h`;
}

async function saveSchedule() {
  const isMulti = document.getElementById('s-multi-schedule').checked;
  const days    = [];
  document.querySelectorAll('.day-check:checked').forEach(cb => days.push(parseInt(cb.value)));
  if (days.length === 0) { showToast('Please select at least one working day.', 'error'); return; }

  // Compute OT-to-leave from time inputs automatically
  const startEl = document.getElementById('s-work-start');
  const endEl   = document.getElementById('s-work-end');
  let start = '', end = '', perDaySchedule = {};
  let otToLeaveHours = null;

  if (isMulti) {
    let valid = true;
    days.forEach(dayIdx => {
      const s = document.getElementById(`pd-start-${dayIdx}`)?.value;
      const e = document.getElementById(`pd-end-${dayIdx}`)?.value;
      if (!s || !e) { valid = false; return; }
      perDaySchedule[dayIdx] = { start: s, end: e };
    });
    if (!valid) { showToast('Please fill in all start and end times.', 'error'); return; }
    const firstDay = days[0];
    start = perDaySchedule[firstDay]?.start || '08:00';
    end   = perDaySchedule[firstDay]?.end   || '17:00';
  } else {
    start = startEl?.value || '';
    end   = endEl?.value   || '';
    if (!start || !end) { showToast('Please set work start and end times.', 'error'); return; }
  }

  // Auto-compute OT-to-leave hours from start/end
  const ws = timeInputToHm(start);
  const we = timeInputToHm(end);
  if (ws && we) {
    const mins = (we.h * 60 + we.m) - (ws.h * 60 + ws.m);
    if (mins > 0) otToLeaveHours = Math.round(mins / 60 * 10) / 10;
  }

  const btn = document.getElementById('btn-save-schedule');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await db.collection('users').doc(currentUser.uid)
            .collection('config').doc('settings')
            .set({ workStart: start, workEnd: end, workDays: days,
                   multiSchedule: isMulti, perDaySchedule,
                   otToLeaveHours, isNewUser: false }, { merge: true });
    clearSettingsCache();
    userSettings = await getUserSettings(currentUser.uid);
    showToast('Schedule saved ✓', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Schedule';
  }
}
