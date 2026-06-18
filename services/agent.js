// ── Import ALL Services ──
const { getRecentEmails, formatEmailsForContext } = require('./gmail');
const { getUpcomingEvents, createCalendarEvent, formatEventsForContext } = require('./calendar');
const { searchDriveFiles, readGoogleDoc, formatFilesForContext } = require('./drive');
const { readSheetRange, formatSheetForContext } = require('./sheets');
const { getTasks, createTask, formatTasksForContext } = require('./tasks');

// ─────────────────────────────────────────────────────────────────────
// PROVIDER HELPERS
// Groq  → fast, small context  → Gmail / Calendar / Tasks / Sheets
// Gemini → huge context (1M)   → Drive search / Google Docs
// ─────────────────────────────────────────────────────────────────────

async function callGroq(messages, systemPrompt, tools) {
  if (!process.env.GROQ_API_KEY) throw new Error('No GROQ_API_KEY');
  const body = {
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    temperature: 0,
    parallel_tool_calls: false
  };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const msg = data.choices[0].message;
  if (msg.tool_calls?.length > 0) return {
    action: 'tool_calls',
    calls: msg.tool_calls.map(tc => ({ id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) })),
    rawMessage: msg
  };
  return { action: 'text', text: msg.content || '' };
}

async function callGemini(messages, systemPrompt, tools) {
  if (!process.env.GEMINI_API_KEY) throw new Error('No GEMINI_API_KEY');
  const body = {
    model: 'gemini-2.0-flash',
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    temperature: 0
  };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const msg = data.choices[0].message;
  if (msg.tool_calls?.length > 0) return {
    action: 'tool_calls',
    calls: msg.tool_calls.map(tc => ({ id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) })),
    rawMessage: msg
  };
  return { action: 'text', text: msg.content || '' };
}

async function askAny(messages, systemPrompt, tools) {
  const errors = [];
  for (const fn of [callGroq, callGemini]) {
    try { return await fn(messages, systemPrompt, tools); }
    catch (e) { errors.push(e.message); }
  }
  throw new Error(`All providers failed: ${errors.join(' | ')}`);
}

// ── AGENT TOOL DEFINITIONS ───────────────────────────────────────────
const tools = [
  { type: 'function', function: { name: 'read_gmail',            description: 'Check recent emails from inbox only (no promotions).',          parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_calendar',         description: 'Check upcoming meetings and schedule.',                          parameters: { type: 'object', properties: { timeframe: { type: 'string' } } } } },
  { type: 'function', function: { name: 'create_calendar_event', description: 'Create a new event on Google Calendar.',                         parameters: { type: 'object', properties: { title: { type: 'string', description: 'Event title' }, startTime: { type: 'string', description: 'Start time e.g. "2026-06-18T14:00:00"' }, endTime: { type: 'string', description: 'End time e.g. "2026-06-18T15:00:00". Optional.' }, description: { type: 'string', description: 'Optional notes.' } }, required: ['title', 'startTime'] } } },
  { type: 'function', function: { name: 'read_tasks',            description: 'Fetch pending to-do items.',                                     parameters: { type: 'object', properties: { status: { type: 'string' } } } } },
  { type: 'function', function: { name: 'create_task',           description: 'Create a new task.',                                             parameters: { type: 'object', properties: { title: { type: 'string' }, notes: { type: 'string' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'search_google_drive',   description: 'Search Drive for files by name or content.',                     parameters: { type: 'object', properties: { searchQuery: { type: 'string' } }, required: ['searchQuery'] } } },
  { type: 'function', function: { name: 'read_google_doc',       description: 'Read the full text of a Google Doc. Requires a real fileId (not a file name). Always call search_google_drive first to get the fileId.', parameters: { type: 'object', properties: { fileId: { type: 'string', description: 'The Google Drive file ID, e.g. "1Ud5_hRJbaJv8viQj..."' } }, required: ['fileId'] } } },
  { type: 'function', function: { name: 'read_google_sheets',    description: 'Read data from a Google Spreadsheet using its spreadsheet ID.',  parameters: { type: 'object', properties: { spreadsheetId: { type: 'string', description: 'The spreadsheet ID extracted from the URL' }, range: { type: 'string', description: 'Cell range e.g. A1:Z50' } }, required: ['spreadsheetId'] } } }
];

const systemPrompt = `You are Mimo, an elite AI assistant connected to Google Workspace.
RULES:
1. Be direct and concise. No preamble.
2. Never mention which tools or APIs you used.
3. No JSON in responses — plain text only.
4. For lists use clean bullet points.
5. CRITICAL for Google Docs: always call search_google_drive FIRST to get the fileId, then call read_google_doc with that ID. Never pass a file name as a fileId.
6. CRITICAL for Calendar events: when creating an event, convert the user's time to a full ISO datetime string like "2026-06-18T14:00:00" before calling create_calendar_event. Today is ${new Date().toISOString().split('T')[0]}.
7. CRITICAL for Sheets: the spreadsheetId is the long string between /d/ and /edit in a Google Sheets URL.`;

// ── STEP 1: Intent detection ─────────────────────────────────────────
async function determineIntentAndAsk(question, history) {
  const messages = [...history.slice(-4), { role: 'user', content: question }];
  const aiRes = await askAny(messages, systemPrompt, tools);
  if (aiRes.action === 'text') return { intent: 'ANSWER', answer: aiRes.text };
  return { intent: 'SEARCH', toolCalls: aiRes.calls, rawMessage: aiRes.rawMessage, messages };
}

// ── STEP 2: Execute tools with smart provider routing ────────────────
async function executeAgentSearch(intentData, googleAccessToken) {
  const { toolCalls, rawMessage, messages } = intentData;
  const sourcesUsed = [];
  let usedLargeContext = false;

  const toolResults = await Promise.all(toolCalls.map(async (call) => {
    const { name, input, id } = call;
    try {

      // ── Small-context tools (Groq synthesises) ───────────────────
      if (name === 'read_gmail') {
        sourcesUsed.push('Gmail');
        const emails = await getRecentEmails(googleAccessToken, 15);
        const truncated = emails.map(e => ({ ...e, body: (e.body || e.snippet || '').substring(0, 500) }));
        return { id, name, resultData: formatEmailsForContext(truncated) };
      }

      if (name === 'read_calendar') {
        sourcesUsed.push('Calendar');
        return { id, name, resultData: formatEventsForContext(await getUpcomingEvents(googleAccessToken, 10)) };
      }

      if (name === 'create_calendar_event') {
        sourcesUsed.push('Calendar');
        const event = await createCalendarEvent(
          googleAccessToken,
          input.title,
          input.startTime,
          input.endTime || null,
          input.description || ''
        );
        return { id, name, resultData: `Success: Event "${event.title}" created from ${event.start} to ${event.end}.` };
      }

      if (name === 'read_tasks') {
        sourcesUsed.push('Tasks');
        return { id, name, resultData: formatTasksForContext(await getTasks(googleAccessToken, 15)) };
      }

      if (name === 'create_task') {
        sourcesUsed.push('Tasks');
        const newTask = await createTask(googleAccessToken, input.title, input.notes || '');
        return { id, name, resultData: `Success: Task "${newTask.title}" created.` };
      }

      if (name === 'read_google_sheets') {
        sourcesUsed.push('Sheets');
        // Extract ID from full URL if user accidentally passed the whole URL
        const rawId = input.spreadsheetId || '';
        const match = rawId.match(/\/d\/([a-zA-Z0-9-_]+)/);
        const spreadsheetId = match ? match[1] : rawId;
        return { id, name, resultData: formatSheetForContext(await readSheetRange(googleAccessToken, spreadsheetId, input.range || 'A1:Z100')) };
      }

      // ── Large-context tools (Gemini synthesises) ─────────────────
      if (name === 'search_google_drive') {
        sourcesUsed.push('Drive');
        usedLargeContext = true;
        return { id, name, resultData: formatFilesForContext(await searchDriveFiles(googleAccessToken, input.searchQuery, 5)) };
      }

      if (name === 'read_google_doc') {
        sourcesUsed.push('Google Docs');
        usedLargeContext = true;
        const docContent = await readGoogleDoc(googleAccessToken, input.fileId);
        if (!docContent || docContent.length < 50) throw new Error('Document is empty or inaccessible.');
        return { id, name, resultData: docContent.substring(0, 80000) };
      }

      return { id, name, resultData: 'Unknown tool' };
    } catch (err) {
      return { id, name, resultData: `Error: ${err.message}` };
    }
  }));

  // ── Error check ──────────────────────────────────────────────────
  const toolErrors = toolResults.filter(tr => tr.resultData.startsWith('Error'));
  if (toolErrors.length > 0) {
    return { answer: `I had trouble accessing your data: ${toolErrors[0].resultData}`, source: 'Error' };
  }

  // ── Final synthesis ──────────────────────────────────────────────
  const finalMessages = [
    ...messages,
    rawMessage,
    ...toolResults.map(tr => ({ role: 'tool', tool_call_id: tr.id, name: tr.name, content: tr.resultData }))
  ];

  let finalRes;
  if (usedLargeContext) {
    try {
      finalRes = await callGemini(finalMessages, systemPrompt, null);
    } catch (e) {
      console.warn('Gemini synthesis failed, falling back to Groq with truncation:', e.message);
      const truncatedMessages = finalMessages.map(m => {
        if (m.role === 'tool' && m.content && m.content.length > 3000) {
          return { ...m, content: m.content.substring(0, 3000) + '\n...[truncated]' };
        }
        return m;
      });
      finalRes = await callGroq(truncatedMessages, systemPrompt, null);
    }
  } else {
    try {
      finalRes = await callGroq(finalMessages, systemPrompt, null);
    } catch (e) {
      console.warn('Groq synthesis failed, falling back to Gemini:', e.message);
      finalRes = await callGemini(finalMessages, systemPrompt, null);
    }
  }

  return {
    answer: finalRes.text || 'Done.',
    source: [...new Set(sourcesUsed)].join(', ')
  };
}

module.exports = { determineIntentAndAsk, executeAgentSearch };