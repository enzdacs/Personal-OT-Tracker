// =============================================
// companies.js — Work history (Companies page)
// =============================================

let currentUser  = null;
let userSettings = null;
let companies    = [];
let activeRecordCount = 0;
let earliestRecordDate = null;
let loadError = '';

document.addEventListener('DOMContentLoaded', () => {
  showLoader();
  requireAuth(async user => {
    currentUser  = user;
    userSettings = await getUserSettings(user.uid);
    updateSidebarUser();
    initSidebar();
    startLiveClock(document.getElementById('clock-time'), document.getElementById('clock-date'));
    try {
      await loadCompanies();
      initNotifications(user, userSettings);
    } catch (e) {
      console.error(e);
    } finally {
      hideLoader(); // always release the loader, even if something above failed
    }
  });
  document.getElementById('btn-logout').addEventListener('click', confirmAndSignOut);
});

function updateSidebarUser() {
  const name = userSettings.fullName || currentUser.email;
  document.getElementById('sidebar-username').textContent = name;
  document.getElementById('sidebar-dept').textContent     = userSettings.jobPosition || userSettings.department || 'Employee';
  document.getElementById('sidebar-avatar').textContent   = getInitials(name);
}

async function loadCompanies() {
  const userRef = db.collection('users').doc(currentUser.uid);
  // Read separately so a problem with one never blanks out the page
  try {
    const cSnap = await userRef.collection('companies').get();
    companies = cSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''));
    loadError = '';
  } catch (e) {
    console.error(e);
    companies = [];
    loadError = e.code === 'permission-denied'
      ? "Couldn't load your company history — your Firestore rules don't allow access to the companies collection yet."
      : "Couldn't load your company history. Please try again.";
  }
  try {
    const aSnap = await userRef.collection('attendance').get();
    const ids = aSnap.docs.map(d => d.id).sort();
    activeRecordCount  = aSnap.size;
    earliestRecordDate = ids[0] || null;
  } catch (e) {
    activeRecordCount = 0; earliestRecordDate = null;
  }
  renderCompanies();
}

// ── helpers ──────────────────────────────────
function fmtMonthYear(ymd) {
  if (!ymd) return '';
  const [y, m] = ymd.split('-').map(Number);
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] + ' ' + y;
}
function fmtDuration(startYmd, endYmd) {
  if (!startYmd || !endYmd) return '';
  const [sy, sm] = startYmd.split('-').map(Number), [ey, em] = endYmd.split('-').map(Number);
  const total = Math.max(1, (ey - sy) * 12 + (em - sm) + 1); // inclusive, like LinkedIn
  const yrs = Math.floor(total / 12), mos = total % 12;
  return [yrs ? `${yrs} yr${yrs > 1 ? 's' : ''}` : '', mos ? `${mos} mo${mos > 1 ? 's' : ''}` : ''].filter(Boolean).join(' ');
}
function logoHtml(name) {
  const colors = ['#2563EB','#7C3AED','#DB2777','#EA580C','#059669','#0891B2','#CA8A04','#4F46E5'];
  let h = 0; for (const ch of name || '?') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const words = (name || '?').trim().split(/\s+/);
  const initials = ((words[0] || '?')[0] + (words[1] ? words[1][0] : '')).toUpperCase();
  return `<div class="co-logo" style="background:${colors[h % colors.length]}">${escapeHtml(initials)}</div>`;
}

function renderCompanies() {
  const el = document.getElementById('companies-list');
  let html = '';

  // Current job (from Settings)
  if (userSettings.companyName || userSettings.jobPosition) {
    const since = earliestRecordDate;
    html += `
      <div class="co-item">
        ${logoHtml(userSettings.companyName || userSettings.jobPosition)}
        <div class="co-main">
          <div class="co-title">${escapeHtml(userSettings.jobPosition || 'Current role')}</div>
          <div class="co-sub">${escapeHtml(userSettings.companyName || '')} · ${userSettings.userType === 'intern' ? 'Internship / OJT' : 'Employee'}</div>
          <div class="co-meta">${since ? fmtMonthYear(since) + ' – ' : ''}Present${since ? ' · ' + fmtDuration(since, getDateKey()) : ''}</div>
          <span class="badge badge-success" style="margin-top:.4rem">Current</span>
        </div>
      </div>`;
  }

  html += companies.map(c => {
    const st = c.stats || {};
    const reason = c.reason === 'Other' && c.reasonOther ? c.reasonOther : c.reason;
    const range = `${c.startDate ? fmtMonthYear(c.startDate) : '—'} – ${fmtMonthYear(c.endDate)}`;
    const dur = fmtDuration(c.startDate, c.endDate);
    const place = [c.location, c.workSetup].filter(Boolean).join(' · ');
    return `
      <div class="co-item">
        ${logoHtml(c.companyName)}
        <div class="co-main">
          <div class="co-title">${escapeHtml(c.jobTitle || c.companyName)}</div>
          <div class="co-sub">${escapeHtml(c.companyName)}${c.employmentType ? ' · ' + escapeHtml(c.employmentType) : ''}</div>
          <div class="co-meta">${range}${dur ? ' · ' + dur : ''}</div>
          ${place ? `<div class="co-meta">${escapeHtml(place)}</div>` : ''}
          <div style="margin-top:.35rem">
            ${c.rating ? `<span class="co-stars" title="${c.rating} out of 5">${'★'.repeat(c.rating)}${'☆'.repeat(5 - c.rating)}</span>` : ''}
            <span class="co-chip">Ended: ${escapeHtml(reason || '—')}</span>
          </div>
          ${c.description ? `<div class="co-desc">${escapeHtml(c.description)}</div>` : ''}
          ${c.achievements ? `<div class="co-desc"><strong>Achievements:</strong> ${escapeHtml(c.achievements)}</div>` : ''}
          ${(c.skills || []).length ? `<div>${c.skills.map(x => `<span class="co-chip">${escapeHtml(x)}</span>`).join('')}</div>` : ''}
          <div class="co-stats">
            <span><strong>${st.presentDays || 0}</strong> days present</span>
            <span><strong>${st.absences || 0}</strong> absences</span>
            <span><strong>${minutesToHm(st.otEarnedMins || 0)}</strong> OT earned</span>
            <span><strong>${minutesToHm(st.otUsedMins || 0)}</strong> OT used</span>
            <span><strong>${st.leaveDays || 0}</strong> leave days</span>
          </div>
          <div class="co-actions">
            <button class="btn btn-ghost btn-sm" onclick="undoTenure('${c.id}')">↩ Undo Tenure Ended</button>
          </div>
        </div>
      </div>`;
  }).join('');

  const note = t => `<div style="text-align:center;padding:${html ? '1rem' : '2rem'} 1rem;color:var(--text-light);font-size:.88rem">${t}</div>`;
  if (loadError)              html += note(escapeHtml(loadError));
  else if (!companies.length) html += html
    ? note('No past companies yet.')
    : note('<strong>No company info yet.</strong><br>When a job ends, use <strong>+ → Tenure Ended</strong> on the Dashboard to save it here.');
  el.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

// ── Undo: move the archived records back and drop the entry ──
async function undoTenure(id) {
  const c = companies.find(x => x.id === id);
  if (!c) return;
  const n = (c.stats && c.stats.records) || 0;
  const proceed = await showConfirmDialog({
    title: 'Undo Tenure Ended?',
    message: `This restores the <strong>${n}</strong> archived record${n !== 1 ? 's' : ''} from <strong>${escapeHtml(c.companyName)}</strong> to your Dashboard, Attendance, Overtime and Badges, and removes it from this list.` +
      (activeRecordCount > 0 ? ` You already have ${activeRecordCount} record${activeRecordCount !== 1 ? 's' : ''} in your current job; they stay, but a restored record replaces any on the same date.` : ''),
    confirmLabel: 'Undo',
    danger: true,
  });
  if (!proceed) return;

  try {
    const userRef = db.collection('users').doc(currentUser.uid);
    const attCol  = userRef.collection('attendance');
    const compRef = userRef.collection('companies').doc(id);
    const arch    = await compRef.collection('records').get();

    // Restore first, delete the archive after — a failure midway never loses data
    await commitInChunks(arch.docs.map(d => b => b.set(attCol.doc(d.id), d.data())));
    await commitInChunks(arch.docs.map(d => b => b.delete(d.ref)));

    // Bring back the company/position only if the user hasn't set a newer job since
    const snap = c.settingsSnapshot || {};
    if (!userSettings.companyName && !userSettings.jobPosition && (snap.companyName || snap.jobPosition)) {
      await userRef.collection('config').doc('settings')
        .set({ companyName: snap.companyName || '', jobPosition: snap.jobPosition || '' }, { merge: true });
    }
    await compRef.delete();

    clearSettingsCache();
    userSettings = await getUserSettings(currentUser.uid);
    updateSidebarUser();
    await loadCompanies();
    showToast(`Restored ${arch.size} records from ${c.companyName}.`, 'success');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function commitInChunks(ops, size = 400) {
  for (let i = 0; i < ops.length; i += size) {
    const batch = db.batch();
    ops.slice(i, i + size).forEach(fn => fn(batch));
    await batch.commit();
  }
}
