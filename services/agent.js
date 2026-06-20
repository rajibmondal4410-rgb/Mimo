// ── Import ALL Services ──
const { getRecentEmails, formatEmailsForContext } = require('./gmail');
const { getUpcomingEvents, createCalendarEvent, formatEventsForContext } = require('./calendar');
const { listAllDriveFiles, searchDriveFiles, readGoogleDoc, formatFilesForContext } = require('./drive');
const { readSheetRange, formatSheetForContext } = require('./sheets');
const { getTasks, createTask, formatTasksForContext } = require('./tasks');

// ─────────────────────────────────────────────────────────────────────
// PROVIDER HELPERS
// Groq  → fast, small context  → Gmail / Calendar / Tasks / Sheets
// Gemini → huge context (1M)   → Drive / Docs
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
  { type: 'function', function: { name: 'read_gmail',
      description: 'Check recent emails from inbox only (no promotions).',
      parameters: { type: 'object', properties: {} } } },

  { type: 'function', function: { name: 'read_calendar',
      description: 'Check upcoming meetings and schedule.',
      parameters: { type: 'object', properties: { timeframe: { type: 'string' } } } } },

  { type: 'function', function: { name: 'create_calendar_event',
      description: 'Create a new event on Google Calendar.',
      parameters: { type: 'object', properties: {
        title:       { type: 'string', description: 'Event title' },
        startTime:   { type: 'string', description: 'Naive local datetime, NO timezone suffix. e.g. "2026-06-18T14:00:00"' },
        endTime:     { type: 'string', description: 'Naive local datetime, NO timezone suffix. Optional, defaults to 1hr after start.' },
        description: { type: 'string', description: 'Optional notes.' }
      }, required: ['title', 'startTime'] } } },

  { type: 'function', function: { name: 'read_tasks',
      description: 'Fetch pending to-do items.',
      parameters: { type: 'object', properties: { status: { type: 'string' } } } } },

  { type: 'function', function: { name: 'create_task',
      description: 'Create a new task.',
      parameters: { type: 'object', properties: {
        title: { type: 'string' },
        notes: { type: 'string' }
      }, required: ['title'] } } },

  { type: 'function', function: { name: 'list_drive_files',
      description: 'List ALL files in the user\'s Google Drive. Use this when the user asks "what files do I have", "show my drive", or "list my documents".',
      parameters: { type: 'object', properties: {
        maxResults: { type: 'number', description: 'How many files to list. Default 50.' }
      } } } },

  { type: 'function', function: { name: 'search_google_drive',
      description: 'Search Drive for a specific file by name or keyword. Use short keywords (2-4 words max). Use this when user asks about a specific file.',
      parameters: { type: 'object', properties: {
        searchQuery: { type: 'string', description: 'Short keyword e.g. "Startup Business" not the full title' }
      }, required: ['searchQuery'] } } },

  { type: 'function', function: { name: 'read_google_doc',
      description: 'Read the full text content of a Google Doc. ALWAYS call search_google_drive or list_drive_files first to get the fileId. Never pass a file name — only a real fileId string like "1Ud5_hRJbaJv8...".',
      parameters: { type: 'object', properties: {
        fileId: { type: 'string', description: 'The Google Drive file ID from search results.' }
      }, required: ['fileId'] } } },

  { type: 'function', function: { name: 'read_google_sheets',
      description: 'Read data from a Google Spreadsheet.',
      parameters: { type: 'object', properties: {
        spreadsheetId: { type: 'string', description: 'Only the ID between /d/ and /edit in the URL. e.g. "1DJU9RAxvm-C3B4r1LG3n6ny38kai"' },
        range:         { type: 'string', description: 'Cell range e.g. A1:Z100.' }
      }, required: ['spreadsheetId'] } } }
];

const systemPrompt = `You are Mimo, an elite AI assistant connected to Google Workspace.
RULES:
1. Be direct and concise. No preamble.
2. Never mention which tools or APIs you used.
3. No JSON in responses — plain text only.
4. For lists use clean bullet points.
5. CRITICAL — Google Docs: call search_google_drive or list_drive_files FIRST to get the fileId. Then call read_google_doc with that fileId. Never pass a file name as a fileId.
6. CRITICAL — Calendar: generate startTime as a naive local datetime with NO timezone suffix e.g. "2026-06-20T14:00:00". Never add Z or +05:30.
7. CRITICAL — Sheets: spreadsheetId is ONLY the string between /d/ and /edit in the URL.
8. CRITICAL — Drive listing: when user asks to list or show all files, use list_drive_files. When searching for a specific file, use search_google_drive with short keywords.`;

// ── STEP 1: Intent detection ─────────────────────────────────────────
async function determineIntentAndAsk(question, history, timezone = 'Asia/Kolkata') {
  const messages = [...history.slice(-4), { role: 'user', content: question }];
  const aiRes = await askAny(messages, systemPrompt, tools);
  if (aiRes.action === 'text') return { intent: 'ANSWER', answer: aiRes.text };
  return { intent: 'SEARCH', toolCalls: aiRes.calls, rawMessage: aiRes.rawMessage, messages };
}

// ── STEP 2: Execute tools ────────────────────────────────────────────
async function executeAgentSearch(intentData, googleAccessToken, timezone = 'Asia/Kolkata') {
  const { toolCalls, rawMessage, messages } = intentData;
  const sourcesUsed = [];
  let usedLargeContext = false;

  const toolResults = await Promise.all(toolCalls.map(async (call) => {
    const { name, input, id } = call;
    try {

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
          input.description || '',
          timezone
        );
        return { id, name, resultData: `Success: "${event.title}" created from ${event.start} to ${event.end}.` };
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
        const rawId = (input.spreadsheetId || '').trim();
        const match = rawId.match(/\/d\/([\w-]+)/);
        const spreadsheetId = match ? match[1] : rawId;
        console.log(`[Sheets] ID resolved: "${rawId}" → "${spreadsheetId}"`);
        return { id, name, resultData: formatSheetForContext(await readSheetRange(googleAccessToken, spreadsheetId, input.range || 'A1:Z100')) };
      }

      // ── Large-context tools → Gemini synthesises ─────────────────
      if (name === 'list_drive_files') {
        sourcesUsed.push('Drive');
        usedLargeContext = true;
        const max = input.maxResults || 50;
        const files = await listAllDriveFiles(googleAccessToken, max);
        return { id, name, resultData: formatFilesForContext(files) };
      }

      if (name === 'search_google_drive') {
        sourcesUsed.push('Drive');
        usedLargeContext = true;
        return { id, name, resultData: formatFilesForContext(await searchDriveFiles(googleAccessToken, input.searchQuery, 20)) };
      }

      if (name === 'read_google_doc') {
        sourcesUsed.push('Google Docs');
        usedLargeContext = true;
        const docContent = await readGoogleDoc(googleAccessToken, input.fileId);
        if (!docContent || docContent.length < 10) throw new Error('Document is empty or inaccessible.');
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
      console.warn('Gemini synthesis failed, falling back to Groq:', e.message);
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