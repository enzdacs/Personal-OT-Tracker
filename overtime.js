// =============================================
// overtime.js — Overtime analytics
// =============================================

let currentUser   = null;
let userSettings  = null;
let allRecords    = [];
let charts        = {};
let currentPeriod = 'month';

document.addEventListener('DOMContentLoaded', () => {
  showLoader();
  requireAuth(async user => {
    currentUser  = user;
    userSettings = await getUserSettings(user.uid);
    updateSidebarUser();
    initSidebar();
    startLiveClock(document.getElementById('clock-time'), document.getElementById('clock-date'));
    await loadData();
    hideLoader();
  });

  document.querySelectorAll('.period-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      renderAll();
    });
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await auth.signOut(); window.location.href = 'index.html';
  });
});

function updateSidebarUser() {
  const name = userSettings.fullName || currentUser.email;
  document.getElementById('sidebar-username').textContent = name;
  document.getElementById('sidebar-dept').textContent     = userSettings.department || 'Employee';
  document.getElementById('sidebar-avatar').textContent   = getInitials(name);
}

async function loadData() {
  const snap = await db.collection('users').doc(currentUser.uid)
                       .collection('attendance').orderBy('date', 'asc').get();
  allRecords = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderAll();
}

function getFilteredRecords() {
  const now   = getManilaDate();
  const today = getDateKey();
  if (currentPeriod === 'today')  return allRecords.filter(r => r.date === today);
  if (currentPeriod === 'week') {
    const ws = weekStart(today);
    return allRecords.filter(r => r.date >= ws && r.date <= today);
  }
  if (currentPeriod === 'month') {
    const prefix = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    return allRecords.filter(r => r.date.startsWith(prefix));
  }
  if (currentPeriod === 'year') return allRecords.filter(r => r.date.startsWith(`${now.getFullYear()}`));
  return allRecords;
}

function getPeriodLabel() {
  return { today:"Today's", week:"This Week's", month:"This Month's", year:"This Year's" }[currentPeriod] || '';
}

function renderAll() {
  const recs      = getFilteredRecords();
  const totalOT   = allRecords.reduce((s, r) => s + (r.otMinutes||0), 0);
  const usedOT    = allRecords.filter(r => r.otUsed).reduce((s, r) => s + (r.otMinutes||0), 0);
  const remaining = totalOT - usedOT;
  const periodOT  = recs.reduce((s, r) => s + (r.otMinutes||0), 0);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ot-total',     minutesToHm(totalOT));
  set('ot-used',      minutesToHm(usedOT));
  set('ot-remaining', minutesToHm(remaining));
  set('ot-period',    minutesToHm(periodOT));
  set('ot-period-label', getPeriodLabel() + ' OT');

  renderOTChart(recs);
  renderOTTable(recs);
}

function renderOTChart(recs) {
  const ctx = document.getElementById('chart-ot');
  if (!ctx) return;
  let labels = [], data = [];

  if (currentPeriod === 'today') {
    const rec = recs[0];
    labels = ['Work Hours','Overtime'];
    data   = [rec ? Math.round((rec.workMinutes||0)/60*10)/10 : 0,
               rec ? Math.round((rec.otMinutes||0)/60*10)/10 : 0];
  } else if (currentPeriod === 'week') {
    const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const dayMap = {1:0,2:1,3:2,4:3,5:4,6:5,0:6};
    labels = days; data = new Array(7).fill(0);
    recs.forEach(r => { const idx = getDayIndex(r.date); data[dayMap[idx]] += Math.round((r.otMinutes||0)/60*10)/10; });
  } else if (currentPeriod === 'month') {
    const byDate = {};
    recs.forEach(r => { byDate[r.date] = (byDate[r.date]||0) + (r.otMinutes||0); });
    const sorted = Object.keys(byDate).sort();
    labels = sorted.map(d => d.split('-')[2]);
    data   = sorted.map(d => Math.round(byDate[d]/60*10)/10);
  } else {
    const byMonth = {};
    recs.forEach(r => { const mo = r.date.substring(0,7); byMonth[mo] = (byMonth[mo]||0)+(r.otMinutes||0); });
    const sorted = Object.keys(byMonth).sort();
    const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    labels = sorted.map(m => mNames[parseInt(m.split('-')[1])-1]);
    data   = sorted.map(m => Math.round(byMonth[m]/60*10)/10);
  }

  if (charts.ot) charts.ot.destroy();
  charts.ot = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label:'Overtime (hrs)', data, backgroundColor:'rgba(245,158,11,0.7)', borderColor:'rgba(245,158,11,1)', borderWidth:1, borderRadius:5 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend:{ display:false } },
      scales: {
        y: { beginAtZero:true, ticks:{ callback: v => v+'h' }, grid:{ color:'rgba(0,0,0,.05)' } },
        x: { grid:{ display:false } }
      }
    }
  });
}

function renderOTTable(recs) {
  const tbody = document.getElementById('ot-tbody');
  if (!tbody) return;
  const otRecs = recs.filter(r => (r.otMinutes||0) > 0).slice().reverse().slice(0, 20);
  if (otRecs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">⏰</div><p>No overtime records for this period.</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = otRecs.map(r => `
    <tr>
      <td>${formatDateShort(r.date)}</td>
      <td><span class="badge badge-warning">${minutesToHm(r.otMinutes)}</span></td>
      <td>${r.timeOutDisplay || '—'}</td>
      <td>${r.otUsed ? '<span class="badge badge-success">Used</span>' : '<span class="badge badge-gray">Available</span>'}</td>
    </tr>`).join('');
}
