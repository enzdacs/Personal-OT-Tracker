// =============================================
// attendance.js — Attendance analytics
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
    initNotifications(user, userSettings);
    hideLoader();
  });

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay.id); });
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

function renderAll() {
  const recs    = getFilteredRecords();
  const present = recs.filter(r => r.status === 'present').length;
  const absent  = recs.filter(r => r.status === 'absent').length;
  const holiday = recs.filter(r => r.status === 'holiday').length;
  const otLeave = recs.filter(r => r.status === 'ot-leave').length;
  const workDays = present + absent;
  const rate    = workDays > 0 ? Math.round((present / workDays) * 100) : 0;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('a-present',  present);
  set('a-absent',   absent);
  set('a-holidays', holiday);
  set('a-rate',     workDays > 0 ? rate + '%' : '—');
  set('a-ot-leave', otLeave);

  renderDonut(recs, present, absent, holiday, otLeave);
  renderBar(recs);
  renderTable(recs);
}

function renderDonut(recs, present, absent, holiday, otLeave) {
  const ctx = document.getElementById('chart-attendance-donut');
  if (!ctx) return;
  const pending = recs.filter(r => r.status === 'pending').length;
  if (charts.donut) charts.donut.destroy();
  charts.donut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Present', 'Absent', 'Holiday', 'OT Leave', 'Pending'],
      datasets: [{
        data: [present, absent, holiday, otLeave, pending],
        backgroundColor: ['rgba(16,185,129,.75)','rgba(239,68,68,.75)','rgba(124,58,237,.6)','rgba(234,179,8,.8)','rgba(100,116,139,.4)'],
        borderColor: ['#10B981','#EF4444','#7C3AED','#CA8A04','#94A3B8'],
        borderWidth: 1,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: { legend: { position: 'bottom', labels: { padding: 12, font: { size: 11 } } } }
    }
  });
}

function renderBar(recs) {
  const ctx = document.getElementById('chart-attendance-bar');
  if (!ctx) return;
  let labels = [], presentData = [], absentData = [], holidayData = [], otLeaveData = [];

  if (currentPeriod === 'today') {
    const rec = recs[0];
    labels      = ['Today'];
    presentData = [rec && rec.status === 'present'  ? 1 : 0];
    absentData  = [rec && rec.status === 'absent'   ? 1 : 0];
    holidayData = [rec && rec.status === 'holiday'  ? 1 : 0];
    otLeaveData = [rec && rec.status === 'ot-leave' ? 1 : 0];
  } else if (currentPeriod === 'week') {
    const days   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const dayMap = { 1:0,2:1,3:2,4:3,5:4,6:5,0:6 };
    labels = days;
    presentData = new Array(7).fill(0); absentData = new Array(7).fill(0);
    holidayData = new Array(7).fill(0); otLeaveData = new Array(7).fill(0);
    recs.forEach(r => {
      const idx = dayMap[getDayIndex(r.date)];
      if (r.status === 'present')  presentData[idx] = 1;
      if (r.status === 'absent')   absentData[idx]  = 1;
      if (r.status === 'holiday')  holidayData[idx] = 1;
      if (r.status === 'ot-leave') otLeaveData[idx] = 1;
    });
  } else if (currentPeriod === 'month') {
    const weeks = { 'Wk 1':{p:0,a:0,h:0,ol:0},'Wk 2':{p:0,a:0,h:0,ol:0},'Wk 3':{p:0,a:0,h:0,ol:0},'Wk 4':{p:0,a:0,h:0,ol:0},'Wk 5':{p:0,a:0,h:0,ol:0} };
    recs.forEach(r => {
      const day = parseInt(r.date.split('-')[2]);
      const wk  = day<=7?'Wk 1':day<=14?'Wk 2':day<=21?'Wk 3':day<=28?'Wk 4':'Wk 5';
      if (r.status==='present')  weeks[wk].p++;
      if (r.status==='absent')   weeks[wk].a++;
      if (r.status==='holiday')  weeks[wk].h++;
      if (r.status==='ot-leave') weeks[wk].ol++;
    });
    const active = Object.entries(weeks).filter(([,v])=>v.p+v.a+v.h+v.ol>0);
    labels      = active.map(([k])=>k);
    presentData = active.map(([,v])=>v.p);
    absentData  = active.map(([,v])=>v.a);
    holidayData = active.map(([,v])=>v.h);
    otLeaveData = active.map(([,v])=>v.ol);
  } else {
    const byMonth = {};
    recs.forEach(r => {
      const mo = r.date.substring(0,7);
      if (!byMonth[mo]) byMonth[mo]={p:0,a:0,h:0,ol:0};
      if (r.status==='present')  byMonth[mo].p++;
      if (r.status==='absent')   byMonth[mo].a++;
      if (r.status==='holiday')  byMonth[mo].h++;
      if (r.status==='ot-leave') byMonth[mo].ol++;
    });
    const sorted = Object.keys(byMonth).sort();
    const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    labels      = sorted.map(m=>mNames[parseInt(m.split('-')[1])-1]);
    presentData = sorted.map(m=>byMonth[m].p);
    absentData  = sorted.map(m=>byMonth[m].a);
    holidayData = sorted.map(m=>byMonth[m].h);
    otLeaveData = sorted.map(m=>byMonth[m].ol);
  }

  if (charts.bar) charts.bar.destroy();
  charts.bar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label:'Present',  data:presentData, backgroundColor:'rgba(16,185,129,0.75)',  borderColor:'#10B981', borderWidth:1, borderRadius:4 },
        { label:'Absent',   data:absentData,  backgroundColor:'rgba(239,68,68,0.75)',   borderColor:'#EF4444', borderWidth:1, borderRadius:4 },
        { label:'Holiday',  data:holidayData, backgroundColor:'rgba(124,58,237,0.75)',  borderColor:'#7C3AED', borderWidth:1, borderRadius:4 },
        { label:'OT Leave', data:otLeaveData, backgroundColor:'rgba(234,179,8,0.8)',    borderColor:'#CA8A04', borderWidth:1, borderRadius:4 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position:'bottom', labels:{ padding:14, font:{size:11} } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y} day${c.parsed.y!==1?'s':''}` } }
      },
      scales: {
        x: { stacked:true, grid:{display:false} },
        y: { stacked:true, beginAtZero:true, ticks:{stepSize:1}, grid:{color:'rgba(0,0,0,.05)'} }
      }
    }
  });
}

function renderTable(recs) {
  const tbody = document.getElementById('att-tbody');
  if (!tbody) return;
  const displayed = recs.slice().reverse().slice(0, 20);
  if (displayed.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">🗓</div><p>No data for this period.</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = displayed.map(r => {
    let badge;
    if (r.status==='present')       badge = `<span class="badge badge-success">Present</span>`;
    else if (r.status==='absent')   badge = `<span class="badge badge-danger">ABS</span>`;
    else if (r.status==='holiday')  badge = `<span class="badge badge-holiday">HOL</span>`;
    else if (r.status==='ot-leave') badge = `<span class="badge badge-ot-leave">${r.otUsageType || 'FL-OT'}</span>`;
    else                             badge = `<span class="badge badge-gray">Pending</span>`;
    const timeOutDisplay = r.status==='absent' ? 'ABS'
      : r.status==='holiday' ? 'HOL'
      : r.status==='ot-leave' ? (r.otUsageType || 'FL-OT')
      : (r.timeOutDisplay || '—');
    return `<tr>
      <td>${formatDateShort(r.date)}</td>
      <td>${badge}</td>
      <td>${r.workMinutes != null ? minutesToHm(r.workMinutes) : '—'}</td>
      <td>${timeOutDisplay}</td>
    </tr>`;
  }).join('');
}
