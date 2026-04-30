// =============================================
// settings.js — Profile & Security only
// (Work schedule is in schedule.js / schedule.html)
// =============================================

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
    populateForm();
    initNotifications(user, userSettings);
    hideLoader();
  });

  // Profile / Security sub-nav tabs
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.panel).classList.add('active');
    });
  });

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay.id); });
  });

  document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
  document.getElementById('btn-change-pass').addEventListener('click',  changePassword);
  document.getElementById('btn-save-notifications').addEventListener('click', saveNotificationSettings);
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await auth.signOut();
    window.location.href = 'index.html';
  });

  // Mark dirty when profile fields change
  ['s-full-name','s-username','s-department'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', markProfileDirty);
  });

  // Mark dirty when notification fields change
  ['n-shift-warn-mins','n-ot-remind-freq','n-timeout-remind-freq','n-timeout-custom-mins'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.addEventListener('input', markNotifDirty); el.addEventListener('change', markNotifDirty); }
  });
});

let currentUser  = null;
let userSettings = null;
let _profileDirty = false;
let _notifDirty   = false;

function markProfileDirty() {
  _profileDirty = true;
  const btn = document.getElementById('btn-save-profile');
  if (btn) btn.disabled = false;
}

function markNotifDirty() {
  _notifDirty = true;
  const btn = document.getElementById('btn-save-notifications');
  if (btn) btn.disabled = false;
}

function updateSidebarUser() {
  const name = userSettings.fullName || currentUser.email;
  document.getElementById('sidebar-username').textContent = name;
  document.getElementById('sidebar-dept').textContent     = userSettings.department || 'Employee';
  document.getElementById('sidebar-avatar').textContent   = getInitials(name);
}

function populateForm() {
  const s = userSettings;
  document.getElementById('s-full-name').value  = s.fullName   || '';
  document.getElementById('s-username').value   = s.username   || '';
  document.getElementById('s-department').value = s.department || '';

  // Notification settings
  const ns = s.notifSettings || {};
  const shiftWarnEl = document.getElementById('n-shift-warn-mins');
  const otFreqEl    = document.getElementById('n-ot-remind-freq');
  const toFreqEl    = document.getElementById('n-timeout-remind-freq');
  const toCustomEl  = document.getElementById('n-timeout-custom-mins');

  if (shiftWarnEl) shiftWarnEl.value = ns.shiftWarnMins   ?? 5;
  if (otFreqEl)    otFreqEl.value    = ns.otRemindFreq    || 'daily';
  if (toFreqEl)    toFreqEl.value    = ns.timeoutRemindFreq || '60';
  if (toCustomEl)  toCustomEl.value  = ns.timeoutCustomMins || 60;

  // Show/hide custom group based on current value
  const grp = document.getElementById('n-timeout-custom-group');
  if (grp && toFreqEl) grp.style.display = toFreqEl.value === 'custom' ? 'block' : 'none';

  // Disable save buttons until something changes
  _profileDirty = false;
  _notifDirty   = false;
  const profileBtn = document.getElementById('btn-save-profile');
  const notifBtn   = document.getElementById('btn-save-notifications');
  if (profileBtn) profileBtn.disabled = true;
  if (notifBtn)   notifBtn.disabled   = true;
}

async function saveNotificationSettings() {
  const shiftWarnMins    = parseInt(document.getElementById('n-shift-warn-mins')?.value) || 5;
  const otRemindFreq     = document.getElementById('n-ot-remind-freq')?.value     || 'daily';
  const timeoutFreqSel   = document.getElementById('n-timeout-remind-freq')?.value || '60';
  const timeoutCustomMins = parseInt(document.getElementById('n-timeout-custom-mins')?.value) || 60;

  const notifSettings = {
    shiftWarnMins,
    otRemindFreq,
    timeoutRemindFreq: timeoutFreqSel,
    timeoutCustomMins: timeoutFreqSel === 'custom' ? timeoutCustomMins : null,
  };

  const btn = document.getElementById('btn-save-notifications');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await db.collection('users').doc(currentUser.uid)
            .collection('config').doc('settings')
            .set({ notifSettings }, { merge: true });
    clearSettingsCache();
    userSettings = await getUserSettings(currentUser.uid);
    _notifDirty = false;
    showToast('Notification settings saved ✓', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Notification Settings';
    if (!_notifDirty) btn.disabled = true;
  }
}

async function saveProfile() {
  const name     = document.getElementById('s-full-name').value.trim();
  const username = document.getElementById('s-username').value.trim();
  const dept     = document.getElementById('s-department').value.trim();

  if (!name) { showToast('Full name is required.', 'error'); return; }

  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    await db.collection('users').doc(currentUser.uid)
            .collection('config').doc('settings')
            .set({ fullName: name, username, department: dept }, { merge: true });
    clearSettingsCache();
    userSettings = await getUserSettings(currentUser.uid);
    updateSidebarUser();
    _profileDirty = false;
    showToast('Profile saved ✓', 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Profile';
    if (!_profileDirty) btn.disabled = true;
  }
}

async function changePassword() {
  const current = document.getElementById('s-current-pass').value;
  const newPass = document.getElementById('s-new-pass').value;
  const confirm = document.getElementById('s-confirm-pass').value;

  if (!current || !newPass || !confirm) { showToast('Fill in all password fields.', 'error'); return; }
  if (newPass !== confirm)  { showToast('New passwords do not match.', 'error'); return; }
  if (newPass.length < 8)   { showToast('New password must be at least 8 characters.', 'error'); return; }

  const btn = document.getElementById('btn-change-pass');
  btn.disabled = true; btn.textContent = 'Changing…';

  try {
    const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, current);
    await currentUser.reauthenticateWithCredential(cred);
    await currentUser.updatePassword(newPass);
    document.getElementById('s-current-pass').value = '';
    document.getElementById('s-new-pass').value     = '';
    document.getElementById('s-confirm-pass').value = '';
    showToast('Password changed ✓', 'success');
  } catch(e) {
    const map = {
      'auth/wrong-password':        'Current password is incorrect.',
      'auth/weak-password':         'New password is too weak.',
      'auth/requires-recent-login': 'Please sign out and sign back in first.',
    };
    showToast(map[e.code] || e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Change Password';
  }
}
