// netlify/functions/gemini-chat.js
//
// Server-side proxy for the OT Tracker chatbot. This is the ONLY place the Gemini API key
// is ever read — it comes from a Netlify environment variable (Site settings → Environment
// variables → GEMINI_API_KEY), never from anything shipped to the browser.
//
// The frontend (chatbot.js) sends the running conversation + tool definitions here; this
// function just forwards that to Gemini's generateContent endpoint and relays the response
// back. It does NOT touch Firestore or know about attendance data — reads/writes to the
// user's records happen entirely in the browser, authenticated as that user, exactly like
// the rest of the app. This function is a relay, not a privileged backend.

const GEMINI_MODEL = 'gemini-3.7-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'GEMINI_API_KEY is not configured on the server. Set it in Netlify → Site settings → Environment variables, then redeploy.' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { contents, systemInstruction, tools } = payload;
  if (!Array.isArray(contents) || contents.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'contents[] is required' }) };
  }

  // Basic sanity cap so a runaway conversation can't blow up cost/latency in one call
  if (contents.length > 60) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Conversation too long for a single request.' }) };
  }

  const body = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools ? { tools } : {}),
    generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
  };

  try {
    const resp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return {
        statusCode: resp.status, headers,
        body: JSON.stringify({ error: data?.error?.message || 'Gemini API request failed.' }),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not reach Gemini API: ' + e.message }) };
  }
};
