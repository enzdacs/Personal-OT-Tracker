// =============================================
// badges.js — Badges & Streaks (standalone page)
// =============================================

let currentUser   = null;
let userSettings  = null;

document.addEventListener('DOMContentLoaded', () => {
  showLoader();
  requireAuth(async user => {
    currentUser  = user;
    userSettings = await getUserSettings(user.uid);
    updateSidebarUser();
    initSidebar();
    startLiveClock(document.getElementById('clock-time'), document.getElementById('clock-date'));
    await loadAndRenderBadges();
    initNotifications(user, userSettings);
    hideLoader();
  });

  document.getElementById('btn-logout').addEventListener('click', confirmAndSignOut);
});

function updateSidebarUser() {
  const name = userSettings.fullName || currentUser.email;
  document.getElementById('sidebar-username').textContent = name;
  document.getElementById('sidebar-dept').textContent     = userSettings.jobPosition || userSettings.department || 'Employee';
  document.getElementById('sidebar-avatar').textContent   = getInitials(name);
}

// Streaks are fully derived from attendance records (not a stored counter), so this always
// reflects the current state — adding a Time Out or deleting a record and coming back to this
// page recomputes everything fresh, with nothing to fall out of sync.
async function loadAndRenderBadges() {
  const snap = await db.collection('users').doc(currentUser.uid)
                       .collection('attendance').get();
  const records = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderBadgesUI(computeBadges(records, userSettings));
}

function renderBadgesUI(result) {
  document.getElementById('streak-current').textContent = `${result.current} day${result.current === 1 ? '' : 's'}`;
  document.getElementById('streak-longest').textContent = `${result.longest} day${result.longest === 1 ? '' : 's'}`;

  const grid = document.getElementById('badge-grid');
  if (!grid) return;
  grid.innerHTML = BADGE_DEFS.map(b => {
    const isEarned = !!result.earned[b.id];
    const count    = result.counts[b.id] || 0;
    const countLabel = (b.id === 'streak-7' || b.id === 'streak-30')
      ? `Best streak: ${count} day${count === 1 ? '' : 's'}`
      : `Earned ${count} time${count === 1 ? '' : 's'}`;
    return `
      <div class="badge-card ${isEarned ? 'earned' : 'locked'}" style="--badge-color:${b.color};--badge-bg:${b.color}22">
        <div class="badge-icon-ring"><i data-lucide="${b.icon}"></i></div>
        <div class="badge-name">${b.name}</div>
        <div class="badge-desc">${b.desc}</div>
        ${isEarned ? `<div class="badge-count">${countLabel}</div>` : `<div class="badge-count" style="color:var(--text-light)">Not yet earned</div>`}
      </div>`;
  }).join('');
  if (window.lucide) lucide.createIcons();
}
