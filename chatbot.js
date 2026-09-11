// =============================================
// chatbot.js — OT Tracker AI Assistant (Gemini-powered)
// =============================================
// Loaded on every authenticated page, after that page's own script has set up
// currentUser / userSettings / db. Injects its own bubble + panel next to the
// notification bell — no HTML changes needed on any page.
//
// Security note: the Gemini API key never appears in this file or anywhere in the
// browser. Every request goes to /.netlify/functions/gemini-chat, a serverless
// function that holds the key server-side (Netlify env var GEMINI_API_KEY).

const CHATBOT_ENDPOINT = '/.netlify/functions/gemini-chat';

const CHATBOT_SYSTEM_PROMPT = `You are the OT Tracker Assistant, an expert in overtime tracking, attendance logging, and this app's leave conventions (FL-OT = Full Day Leave, HD-OT = Half Day, OS-OT = Offset, all funded by banked OT hours). You help the signed-in user with THEIR OWN attendance and overtime data only.

Rules:
- Never invent numbers. Call get_summary or list_records before answering anything about the user's hours, streaks, or records.
- To add, edit, or delete a record, call the matching tool. You never need to ask the user to confirm in your own words — the app always shows a confirmation step before any change takes effect, and reports back whether the user approved it.
- Dates are "YYYY-MM-DD". Times are 24-hour "HH:MM".
- Keep answers short, concrete, and grounded in the real numbers you looked up.
- If asked something unrelated to attendance/overtime/leave, politely redirect back to what you can help with.
- If a tool result contains an error or says the user cancelled, explain that plainly rather than pretending it succeeded.`;

const CHATBOT_TOOLS = [{
  functionDeclarations: [
    {
      name: 'get_summary',
      description: "Get the user's current OT/attendance totals: OT earned, used, and remaining, absences, and streaks.",
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'list_records',
      description: 'List attendance records between two dates (inclusive), optionally filtered by status.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Start date YYYY-MM-DD' },
          to:   { type: 'string', description: 'End date YYYY-MM-DD' },
          status: { type: 'string', description: 'Optional: present, absent, holiday, ot-leave, or pending' },
        },
        required: ['from', 'to'],
      },
    },
    {
      name: 'add_record',
      description: 'Add or overwrite an attendance record for a date. Requires user confirmation before it takes effect.',
      parameters: {
        type: 'object',
        properties: {
          date:    { type: 'string', description: 'YYYY-MM-DD' },
          status:  { type: 'string', description: 'present, absent, or holiday' },
          timeIn:  { type: 'string', description: 'HH:MM 24-hour — only for status=present' },
          timeOut: { type: 'string', description: 'HH:MM 24-hour — only for status=present' },
          note:    { type: 'string' },
        },
        required: ['date', 'status'],
      },
    },
    {
      name: 'edit_record',
      description: 'Edit an existing attendance record. Only include fields that should change. Requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          date:    { type: 'string', description: 'YYYY-MM-DD — identifies the record' },
          status:  { type: 'string' },
          timeIn:  { type: 'string' },
          timeOut: { type: 'string' },
          note:    { type: 'string' },
        },
        required: ['date'],
      },
    },
    {
      name: 'delete_record',
      description: "Delete a date's attendance record entirely. Requires user confirmation.",
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
        required: ['date'],
      },
    },
    {
      name: 'export_records',
      description: 'Export attendance records between two dates as a downloadable CSV file.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD' },
          to:   { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['from', 'to'],
      },
    },
  ],
}];

const CHATBOT_WRITE_TOOLS = new Set(['add_record', 'edit_record', 'delete_record']);

let _chatHistory = [];
let _greetingShown = false;
let _chatOpen = false;
let _chatBusy = false;

document.addEventListener('DOMContentLoaded', () => {
  // Defer so the page's own auth/init logic runs first and sets currentUser/userSettings
  setTimeout(() => {
    injectChatbotUI();
    wireChatbotEvents();
  }, 0);
});

function injectChatbotUI() {
  if (document.getElementById('chatbot-bubble')) return;
  const topbarRight = document.querySelector('.topbar-right');
  if (!topbarRight) return;

  const bubble = document.createElement('button');
  bubble.id = 'chatbot-bubble';
  bubble.className = 'chatbot-bubble';
  bubble.title = 'OT Tracker Assistant';
  bubble.setAttribute('aria-label', 'OT Tracker Assistant');
  bubble.innerHTML = `<i data-lucide="bot" class="icon"></i>`;

  const notifWrap = topbarRight.querySelector('.notif-bell-wrap');
  if (notifWrap) topbarRight.insertBefore(bubble, notifWrap);
  else topbarRight.insertBefore(bubble, topbarRight.firstChild);

  const panel = document.createElement('div');
  panel.id = 'chatbot-panel';
  panel.className = 'chatbot-panel hidden';
  panel.innerHTML = `
    <div class="chatbot-panel-header">
      <span><i data-lucide="bot" class="icon"></i> OT Tracker Assistant</span>
      <button id="chatbot-close" class="modal-close">✕</button>
    </div>
    <div class="chatbot-log" id="chatbot-log"></div>
    <div class="chatbot-typing hidden" id="chatbot-typing">
      <span class="chatbot-dot"></span><span class="chatbot-dot"></span><span class="chatbot-dot"></span>
    </div>
    <div class="chatbot-input-row">
      <input type="text" id="chatbot-input" placeholder="Ask about your OT, attendance, or leave…" autocomplete="off"/>
      <button id="chatbot-send" class="btn btn-primary btn-sm">Send</button>
    </div>`;
  document.body.appendChild(panel);

  if (window.lucide) lucide.createIcons();
}

function wireChatbotEvents() {
  const bubble = document.getElementById('chatbot-bubble');
  const panel  = document.getElementById('chatbot-panel');
  if (!bubble || !panel) return;

  bubble.addEventListener('click', () => {
    _chatOpen = !_chatOpen;
    panel.classList.toggle('hidden', !_chatOpen);
    if (_chatOpen && !_greetingShown) {
      _greetingShown = true;
      appendBotMessage("Hi! I'm your OT Tracker assistant. Ask me about your overtime, attendance, or leave — I can also log, edit, or remove records for you. I'll always show you a confirmation before changing anything.");
      document.getElementById('chatbot-input')?.focus();
    }
  });
  document.getElementById('chatbot-close')?.addEventListener('click', () => {
    _chatOpen = false;
    panel.classList.add('hidden');
  });
  document.getElementById('chatbot-send')?.addEventListener('click', sendChatMessage);
  document.getElementById('chatbot-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
  });
}

function appendBotMessage(text) {
  const log = document.getElementById('chatbot-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'chatbot-msg chatbot-msg-bot';
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function appendUserMessage(text) {
  const log = document.getElementById('chatbot-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'chatbot-msg chatbot-msg-user';
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function setChatBusy(busy) {
  _chatBusy = busy;
  const btn = document.getElementById('chatbot-send');
  if (btn) btn.disabled = busy;
  const typing = document.getElementById('chatbot-typing');
  if (typing) typing.classList.toggle('hidden', !busy);
}

async function sendChatMessage() {
  const input = document.getElementById('chatbot-input');
  const text = (input?.value || '').trim();
  if (!text || _chatBusy) return;
  input.value = '';
  appendUserMessage(text);
  _chatHistory.push({ role: 'user', parts: [{ text }] });
  await runChatTurn();
}

async function runChatTurn() {
  setChatBusy(true);
  try {
    const resp = await fetch(CHATBOT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: _chatHistory,
        systemInstruction: { parts: [{ text: CHATBOT_SYSTEM_PROMPT }] },
        tools: CHATBOT_TOOLS,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      appendBotMessage('⚠ ' + (data.error || 'Something went wrong talking to the assistant.'));
      return;
    }

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    _chatHistory.push({ role: 'model', parts });

    const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    const textParts = parts.filter(p => p.text).map(p => p.text).join('\n').trim();
    if (textParts) appendBotMessage(textParts);

    for (const call of functionCalls) {
      await handleFunctionCall(call);
    }
  } catch (e) {
    appendBotMessage('⚠ Could not reach the assistant: ' + e.message);
  } finally {
    setChatBusy(false);
  }
}

async function handleFunctionCall(call) {
  const { name, args } = call;
  const result = CHATBOT_WRITE_TOOLS.has(name)
    ? await confirmAndRunTool(name, args)
    : await runTool(name, args);

  _chatHistory.push({ role: 'user', parts: [{ functionResponse: { name, response: { result } } }] });
  await runChatTurn();
}

function confirmAndRunTool(name, args) {
  return new Promise(resolve => {
    const log = document.getElementById('chatbot-log');
    if (!log) { resolve({ error: 'UI not ready' }); return; }
    const card = document.createElement('div');
    card.className = 'chatbot-confirm-card';
    card.innerHTML = `
      <div class="chatbot-confirm-title">${describeToolAction(name, args)}</div>
      <div class="chatbot-confirm-actions">
        <button class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button>
        <button class="btn btn-primary btn-sm" data-act="confirm">Confirm</button>
      </div>`;
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;

    const cancelBtn  = card.querySelector('[data-act="cancel"]');
    const confirmBtn = card.querySelector('[data-act="confirm"]');
    cancelBtn.addEventListener('click', () => {
      card.remove();
      appendBotMessage("Okay, I didn't make that change.");
      resolve({ cancelled: true });
    });
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true; cancelBtn.disabled = true;
      confirmBtn.textContent = 'Working…';
      const result = await runTool(name, args);
      card.remove();
      resolve(result);
    });
  });
}

function describeToolAction(name, args) {
  if (name === 'add_record')    return `Add a record for ${args.date} — ${args.status}${args.timeOut ? `, out at ${args.timeOut}` : ''}?`;
  if (name === 'edit_record')   return `Edit the record for ${args.date}?`;
  if (name === 'delete_record') return `Delete the record for ${args.date}? This can't be undone.`;
  return `Run ${name}?`;
}

// ── Tool implementations — same Firestore schema as the rest of the app ──
async function runTool(name, args) {
  try {
    if (name === 'get_summary')    return await toolGetSummary();
    if (name === 'list_records')   return await toolListRecords(args);
    if (name === 'add_record')     return await toolUpsertRecord(args, false);
    if (name === 'edit_record')    return await toolUpsertRecord(args, true);
    if (name === 'delete_record')  return await toolDeleteRecord(args);
    if (name === 'export_records') return await toolExportRecords(args);
    return { error: 'Unknown tool: ' + name };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchAllRecordsForChatbot() {
  const snap = await db.collection('users').doc(currentUser.uid).collection('attendance').get();
  const records = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return applyEffectiveMinutes(records, userSettings);
}

async function toolGetSummary() {
  const records = await fetchAllRecordsForChatbot();
  const pool = getOTPool(records);
  const badges = computeBadges(records, userSettings);
  const absences = records.filter(r => r.status === 'absent').length;
  return {
    otEarnedHuman: minutesToHm(pool.earned),
    otUsedHuman: minutesToHm(pool.used),
    otRemainingHuman: minutesToHm(pool.remaining),
    absences,
    currentStreakDays: badges.current,
    longestStreakDays: badges.longest,
  };
}

async function toolListRecords(args) {
  const { from, to, status } = args || {};
  if (!from || !to) return { error: 'from and to dates are required.' };
  const records = await fetchAllRecordsForChatbot();
  const filtered = records
    .filter(r => r.date >= from && r.date <= to && (!status || r.status === status))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 60); // keep tool results bounded
  return {
    count: filtered.length,
    records: filtered.map(r => ({
      date: r.date, status: r.status,
      timeIn: r.timeInDisplay || null, timeOut: r.timeOutDisplay || null,
      workHours: r.workMinutes != null ? minutesToHm(r.workMinutes) : null,
      otHours: r.otMinutes > 0 ? minutesToHm(r.otMinutes) : null,
      otUsageType: r.otUsageType || null,
    })),
  };
}

async function toolUpsertRecord(args, isEdit) {
  const { date, status, timeIn, timeOut, note } = args || {};
  if (!date) return { error: 'A date is required.' };
  const ref = db.collection('users').doc(currentUser.uid).collection('attendance').doc(date);

  const data = { date };
  if (status) data.status = status;
  if (note != null) data.note = note;

  const effectiveStatus = status || (isEdit ? null : 'present');
  if (effectiveStatus === 'present') {
    const tin  = timeIn  ? timeInputToHm(timeIn)  : timeInputToHm(userSettings.workStart || '08:00');
    if (tin) data.timeInDisplay = formatTime12(tin.h, tin.m);

    if (timeOut) {
      const tout = timeInputToHm(timeOut);
      if (!tout) return { error: 'Invalid timeOut format — use HH:MM.' };
      data.timeOutDisplay = formatTime12(tout.h, tout.m);
      data.timeOutStamp = firebase.firestore.Timestamp.fromDate(
        (() => { const d = getManilaDate(); d.setHours(tout.h, tout.m, 0, 0); return d; })()
      );
      const wEnd = timeInputToHm(userSettings.workEnd || '17:00');
      const base = new Date();
      const toMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), tout.h, tout.m, 0).getTime();
      const sMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), (tin || wEnd).h, (tin || wEnd).m, 0).getTime();
      const eMs  = new Date(base.getFullYear(), base.getMonth(), base.getDate(), wEnd.h, wEnd.m, 0).getTime();
      const breakMins = Math.max(0, Math.round((userSettings.breakHours || 0) * 60));
      const baseWork = Math.max(0, Math.round((Math.min(toMs, eMs) - sMs) / 60_000) - breakMins);
      const otRaw = Math.max(0, Math.round((toMs - eMs) / 60_000));
      const otMins = applyOTCountingRule(otRaw, userSettings.otCountingRule);
      data.workMinutes = baseWork + otMins;
      data.otMinutes = otMins;
    }
  } else if (effectiveStatus === 'absent' || effectiveStatus === 'holiday') {
    data.workMinutes = 0; data.otMinutes = 0;
    data.timeInDisplay = null; data.timeOutDisplay = null; data.timeOutStamp = null;
  }

  await ref.set(data, { merge: true });
  return { success: true, date, action: isEdit ? 'edited' : 'added' };
}

async function toolDeleteRecord(args) {
  const { date } = args || {};
  if (!date) return { error: 'A date is required.' };
  await db.collection('users').doc(currentUser.uid).collection('attendance').doc(date).delete();
  return { success: true, date, action: 'deleted' };
}

async function toolExportRecords(args) {
  const { from, to } = args || {};
  if (!from || !to) return { error: 'from and to dates are required.' };
  const records = await fetchAllRecordsForChatbot();
  const filtered = records.filter(r => r.date >= from && r.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  const rows = [
    ['Date', 'Time In', 'Time Out', 'Status', 'Work Hours', 'Overtime', 'OT Usage'],
    ...filtered.map(r => [
      r.date, r.timeInDisplay || '', r.timeOutDisplay || '', r.status,
      r.workMinutes != null ? minutesToHm(r.workMinutes) : '',
      r.otMinutes > 0 ? minutesToHm(r.otMinutes) : '',
      r.otUsageType || '',
    ]),
  ];
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `OT_Tracker_${from}_to_${to}.csv`;
  a.click();
  return { success: true, count: filtered.length, downloaded: true };
}
