// =============================================
// auth.js — Login & Sign-up logic
// =============================================

document.addEventListener('DOMContentLoaded', () => {
  // If already logged in, redirect
  auth.onAuthStateChanged(user => {
    if (user) window.location.href = 'dashboard.html';
  });

  const loginTab    = document.getElementById('tab-login');
  const signupTab   = document.getElementById('tab-signup');
  const loginPanel  = document.getElementById('panel-login');
  const signupPanel = document.getElementById('panel-signup');

  loginTab.addEventListener('click',  () => switchTab('login'));
  signupTab.addEventListener('click', () => switchTab('signup'));

  function switchTab(which) {
    loginTab.classList.toggle('active',  which === 'login');
    signupTab.classList.toggle('active', which === 'signup');
    loginPanel.classList.toggle('active',  which === 'login');
    signupPanel.classList.toggle('active', which === 'signup');
    clearErrors();
  }

  function clearErrors() {
    document.querySelectorAll('.auth-error').forEach(el => el.classList.add('hidden'));
  }

  function showError(panel, msg) {
    const el = document.getElementById(`error-${panel}`);
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
  }

  // ── Login ────────────────────────────────
  document.getElementById('btn-login').addEventListener('click', async () => {
    const email = document.getElementById('login-email').value.trim();
    const pass  = document.getElementById('login-pass').value;
    clearErrors();

    if (!email || !pass) { showError('login', 'Please fill in all fields.'); return; }

    const btn = document.getElementById('btn-login');
    btn.disabled = true; btn.textContent = 'Signing in…';

    try {
      await auth.signInWithEmailAndPassword(email, pass);
      window.location.href = 'dashboard.html';
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Sign In';
      const map = {
        'auth/user-not-found':  'No account found with that email.',
        'auth/wrong-password':  'Incorrect password.',
        'auth/invalid-email':   'Invalid email address.',
        'auth/too-many-requests': 'Too many attempts. Please try again later.',
      };
      showError('login', map[e.code] || e.message);
    }
  });

  // ── Sign Up ──────────────────────────────
  document.getElementById('btn-signup').addEventListener('click', async () => {
    const name  = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const pass  = document.getElementById('signup-pass').value;
    const pass2 = document.getElementById('signup-pass2').value;
    clearErrors();

    if (!name || !email || !pass || !pass2) { showError('signup', 'Please fill in all fields.'); return; }
    if (pass !== pass2) { showError('signup', 'Passwords do not match.'); return; }
    if (pass.length < 8) { showError('signup', 'Password must be at least 8 characters.'); return; }

    const btn = document.getElementById('btn-signup');
    btn.disabled = true; btn.textContent = 'Creating account…';

    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pass);
      const uid  = cred.user.uid;

      // Save profile + default settings
      await db.collection('users').doc(uid).set({ email, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      await db.collection('users').doc(uid).collection('config').doc('settings').set({
        fullName:    name,
        department:  '',
        workStart:   '08:00',
        workEnd:     '17:00',
        workDays:    [1, 2, 3, 4, 5],
        gracePeriod: 5,
        createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
      });

      window.location.href = 'dashboard.html';
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Create Account';
      const map = {
        'auth/email-already-in-use': 'That email is already registered.',
        'auth/invalid-email':        'Invalid email address.',
        'auth/weak-password':        'Password is too weak.',
      };
      showError('signup', map[e.code] || e.message);
    }
  });

  // Allow Enter key on inputs
  document.querySelectorAll('.auth-input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const panel = input.closest('.auth-panel').id;
      if (panel === 'panel-login') document.getElementById('btn-login').click();
      else document.getElementById('btn-signup').click();
    });
  });
});
