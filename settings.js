// =============================================
// settings.js — User preferences logic
// =============================================

document.addEventListener('DOMContentLoaded', () => {
  showLoader();
  requireAuth(async user => {
    currentUser = user;
    userSettings = await getUserSettings(user.uid);
    updateSidebarUser();
    initSidebar();
    startLiveClock(
      document.getElementById('clock-time'),
      document.getElementById('clock-date')
    );
    populateForm();
    hideLoader();
  });

  // Settings sub-nav
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.panel).classList.add('active');
    });
  });

  document.getElementById('btn-save-schedule').addEventListener('click',  saveSchedule);
  document.getElementById('btn-save-profile').addEventListener('click',   saveProfile);
  document.getElementById('btn-change-pass').addEventListener('click',    changePassword);
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await auth.signOut();
    window.location.href = 'index.html';
  });
});

let currentUser   = null;
let userSettings  = null;

function updateSidebarUser() {
  const name = userSettings.fullName || currentUser.email;
  document.getElementById('sidebar-username').textContent = name;
  document.getElementById('sidebar-dept').textContent     = userSettings.department || 'Employee';
  document.getElementById('sidebar-avatar').textContent   = getInitials(name);
}

function populateForm() {
  const s = userSettings;
  document.getElementById('s-work-start').value    = s.workStart   || '08:00';
  document.getElementById('s-work-end').value      = s.workEnd     || '17:00';
  document.getElementById('s-grace').value         = s.gracePeriod ?? 5;
  document.getElementById('s-full-name').value     = s.fullName    || '';
  document.getElementById('s-department').value    = s.department  || '';

  const workDays = s.workDays || [1,2,3,4,5];
  document.querySelectorAll('.day-check').forEach(cb => {
    cb.checked = workDays.includes(parseInt(cb.value));
  });

  updateWorkHoursPreview();
}

document.addEventListener('change', e => {
  if (e.target.id === 's-work-start' || e.target.id === 's-work-end') {
    updateWorkHoursPreview();
  }
});

function updateWorkHoursPreview() {
  const start = timeInputToHm(document.getElementById('s-work-start').value);
  const end   = timeInputToHm(document.getElementById('s-work-end').value);
  const el    = document.getElementById('work-hours-preview');
  if (!start || !end || !el) return;
  const mins  = (end.h * 60 + end.m) - (start.h * 60 + start.m);
  if (mins <= 0) { el.textContent = 'Invalid range'; return; }
  el.textContent = `= ${minutesToHm(mins)} of work per day`;
}

async function saveSchedule() {
  const start  = document.getElementById('s-work-start').value;
  const end    = document.getElementById('s-work-end').value;
  const grace  = parseInt(document.getElementById('s-grace').value) || 0;
  const days   = [];
  document.querySelectorAll('.day-check:checked').forEach(cb => days.push(parseInt(cb.value)));

  if (!start || !end)      { showToast('Please set work start and end times.', 'error'); return; }
  if (days.length === 0)   { showToast('Please select at least one working day.', 'error'); return; }

  const btn = document.getElementById('btn-save-schedule');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    await db.collection('users').doc(currentUser.uid)
            .collection('config').doc('settings')
            .set({ workStart: start, workEnd: end, gracePeriod: grace, workDays: days }, { merge: true });
    clearSettingsCache();
    userSettings = await getUserSettings(currentUser.uid);
    showToast('Schedule saved ✓', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Schedule';
  }
}

async function saveProfile() {
  const name = document.getElementById('s-full-name').value.trim();
  const dept = document.getElementById('s-department').value.trim();

  if (!name) { showToast('Full name is required.', 'error'); return; }

  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    await db.collection('users').doc(currentUser.uid)
            .collection('config').doc('settings')
            .set({ fullName: name, department: dept }, { merge: true });
    clearSettingsCache();
    userSettings = await getUserSettings(currentUser.uid);
    updateSidebarUser();
    showToast('Profile saved ✓', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Profile';
  }
}

async function changePassword() {
  const current  = document.getElementById('s-current-pass').value;
  const newPass  = document.getElementById('s-new-pass').value;
  const confirm  = document.getElementById('s-confirm-pass').value;

  if (!current || !newPass || !confirm) { showToast('Fill in all password fields.', 'error'); return; }
  if (newPass !== confirm)  { showToast('New passwords do not match.', 'error'); return; }
  if (newPass.length < 8)   { showToast('New password must be at least 8 characters.', 'error'); return; }

  const btn = document.getElementById('btn-change-pass');
  btn.disabled = true; btn.textContent = 'Changing…';

  try {
    // Re-authenticate
    const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, current);
    await currentUser.reauthenticateWithCredential(cred);
    await currentUser.updatePassword(newPass);
    document.getElementById('s-current-pass').value = '';
    document.getElementById('s-new-pass').value     = '';
    document.getElementById('s-confirm-pass').value = '';
    showToast('Password changed ✓', 'success');
  } catch(e) {
    const map = {
      'auth/wrong-password':      'Current password is incorrect.',
      'auth/weak-password':       'New password is too weak.',
      'auth/requires-recent-login': 'Please sign out and sign back in first.',
    };
    showToast(map[e.code] || e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Change Password';
  }
}
