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
    clearInlineErrors();
  }

  function clearErrors() {
    document.querySelectorAll('.auth-error').forEach(el => el.classList.add('hidden'));
  }

  function clearInlineErrors() {
    document.querySelectorAll('.inline-error').forEach(el => { el.textContent = ''; el.style.display = 'none'; });
  }

  function showError(panel, msg) {
    const el = document.getElementById(`error-${panel}`);
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
  }

  function showInlineError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  // ── Real-time inline validation ──────────────

  // Signup: password match check live
  const pass1El  = document.getElementById('signup-pass');
  const pass2El  = document.getElementById('signup-pass2');
  const emailEl  = document.getElementById('signup-email');

  if (pass2El) {
    pass2El.addEventListener('input', () => {
      const p1 = pass1El ? pass1El.value : '';
      const p2 = pass2El.value;
      if (p2.length === 0) { showInlineError('err-pass2', ''); return; }
      if (p1 !== p2) showInlineError('err-pass2', 'Passwords do not match.');
      else showInlineError('err-pass2', '');
    });
  }

  if (pass1El) {
    pass1El.addEventListener('input', () => {
      const p1 = pass1El.value;
      const p2 = pass2El ? pass2El.value : '';
      if (p1.length > 0 && p1.length < 8) showInlineError('err-pass1', 'Password must be at least 8 characters.');
      else showInlineError('err-pass1', '');
      // Re-check confirm if already typed
      if (p2.length > 0) {
        if (p1 !== p2) showInlineError('err-pass2', 'Passwords do not match.');
        else showInlineError('err-pass2', '');
      }
    });
  }

  // Basic email format check on blur (signup)
  if (emailEl) {
    emailEl.addEventListener('blur', () => {
      const val = emailEl.value.trim();
      if (val.length === 0) { showInlineError('err-signup-email', ''); return; }
      const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
      if (!valid) showInlineError('err-signup-email', 'Please enter a valid email address.');
      else showInlineError('err-signup-email', '');
    });
    emailEl.addEventListener('input', () => {
      // Clear email error while typing again
      showInlineError('err-signup-email', '');
    });
  }

  // Login email format check on blur
  const loginEmailEl = document.getElementById('login-email');
  if (loginEmailEl) {
    loginEmailEl.addEventListener('blur', () => {
      const val = loginEmailEl.value.trim();
      if (val.length === 0) { showInlineError('err-login-email', ''); return; }
      const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
      if (!valid) showInlineError('err-login-email', 'Please enter a valid email address.');
      else showInlineError('err-login-email', '');
    });
    loginEmailEl.addEventListener('input', () => showInlineError('err-login-email', ''));
  }

  // ── Login ────────────────────────────────────
  document.getElementById('btn-login').addEventListener('click', async () => {
    const email = document.getElementById('login-email').value.trim();
    const pass  = document.getElementById('login-pass').value;
    clearErrors();
    clearInlineErrors();

    if (!email || !pass) { showError('login', 'Please fill in all fields.'); return; }

    const btn = document.getElementById('btn-login');
    btn.disabled = true; btn.textContent = 'Signing in…';

    try {
      await auth.signInWithEmailAndPassword(email, pass);
      window.location.href = 'dashboard.html';
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Sign In';
      const map = {
        'auth/user-not-found':    'No account found with that email.',
        'auth/wrong-password':    'Incorrect password.',
        'auth/invalid-email':     'Invalid email address.',
        'auth/invalid-credential':'Incorrect email or password.',
        'auth/too-many-requests': 'Too many failed attempts. Please try again later.',
      };
      showError('login', map[e.code] || 'Sign-in failed. Please check your email and password.');
    }
  });

  // ── Sign Up ──────────────────────────────────
  document.getElementById('btn-signup').addEventListener('click', async () => {
    const name  = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const pass  = document.getElementById('signup-pass').value;
    const pass2 = document.getElementById('signup-pass2').value;
    clearErrors();
    clearInlineErrors();

    if (!name || !email || !pass || !pass2) { showError('signup', 'Please fill in all fields.'); return; }

    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!validEmail) { showInlineError('err-signup-email', 'Please enter a valid email address.'); return; }
    if (pass.length < 8) { showInlineError('err-pass1', 'Password must be at least 8 characters.'); return; }
    if (pass !== pass2) { showInlineError('err-pass2', 'Passwords do not match.'); return; }

    const btn = document.getElementById('btn-signup');
    btn.disabled = true; btn.textContent = 'Creating account…';

    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pass);
      const uid  = cred.user.uid;

      // Save profile + minimal default settings (no workStart/workEnd set — user will configure)
      await db.collection('users').doc(uid).set({ email, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
      await db.collection('users').doc(uid).collection('config').doc('settings').set({
        fullName:    name,
        username:    '',
        department:  '',
        workStart:   '',
        workEnd:     '',
        workDays:    [1, 2, 3, 4, 5],
        gracePeriod: 5,
        isNewUser:   true,
        createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
      });

      window.location.href = 'dashboard.html';
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Create Account';
      const map = {
        'auth/email-already-in-use': 'That email address is already registered. Try signing in instead.',
        'auth/invalid-email':        'Please enter a valid email address.',
        'auth/weak-password':        'Password is too weak. Use at least 8 characters.',
      };
      showError('signup', map[e.code] || 'Could not create account. Please try again.');
    }
  });

  // ── Forgot Password ─────────────────────────
  const forgotModal    = document.getElementById('forgot-modal');
  const forgotEmailEl  = document.getElementById('forgot-email');
  const forgotSuccess  = document.getElementById('forgot-success');
  const forgotError    = document.getElementById('forgot-error');

  function openForgotModal() {
    if (forgotEmailEl) forgotEmailEl.value = document.getElementById('login-email')?.value || '';
    if (forgotSuccess) forgotSuccess.style.display = 'none';
    if (forgotError)   forgotError.style.display   = 'none';
    if (forgotModal)   forgotModal.style.display    = 'flex';
  }

  function closeForgotModal() {
    if (forgotModal) forgotModal.style.display = 'none';
  }

  document.getElementById('btn-forgot-password')?.addEventListener('click', openForgotModal);
  document.getElementById('btn-forgot-cancel')?.addEventListener('click',  closeForgotModal);

  // Close modal when clicking backdrop
  forgotModal?.addEventListener('click', e => {
    if (e.target === forgotModal) closeForgotModal();
  });

  document.getElementById('btn-forgot-send')?.addEventListener('click', async () => {
    const email = forgotEmailEl?.value.trim();
    if (forgotSuccess) forgotSuccess.style.display = 'none';
    if (forgotError)   forgotError.style.display   = 'none';

    if (!email) {
      if (forgotError) { forgotError.textContent = 'Please enter your email address.'; forgotError.style.display = 'block'; }
      return;
    }
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!validEmail) {
      if (forgotError) { forgotError.textContent = 'Please enter a valid email address.'; forgotError.style.display = 'block'; }
      return;
    }

    const btn = document.getElementById('btn-forgot-send');
    btn.disabled = true; btn.textContent = 'Sending…';

    try {
      await auth.sendPasswordResetEmail(email);
      if (forgotSuccess) forgotSuccess.style.display = 'block';
      // Auto-close after 4 seconds
      setTimeout(closeForgotModal, 4000);
    } catch(e) {
      const map = {
        'auth/user-not-found':  'No account found with that email address.',
        'auth/invalid-email':   'Please enter a valid email address.',
        'auth/too-many-requests': 'Too many attempts. Please try again later.',
      };
      if (forgotError) {
        forgotError.textContent = map[e.code] || 'Could not send reset email. Please try again.';
        forgotError.style.display = 'block';
      }
    } finally {
      btn.disabled = false; btn.textContent = 'Send Reset Link';
    }
  });

  // Allow Enter key in forgot email field
  forgotEmailEl?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-forgot-send')?.click();
  });
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const panel = input.closest('.auth-panel').id;
      if (panel === 'panel-login') document.getElementById('btn-login').click();
      else document.getElementById('btn-signup').click();
    });
  });
