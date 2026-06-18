// ── Import ALL Services ──
const { getRecentEmails, formatEmailsForContext } = require('./gmail');
const { getUpcomingEvents, formatEventsForContext } = require('./calendar');
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

// Generic fallback — tries Groq first, then Gemini
async function askAny(messages, systemPrompt, tools) {
  const errors = [];
  for (const fn of [callGroq, callGemini]) {
    try { return await fn(messages, systemPrompt, tools); }
    catch (e) { errors.push(e.message); }
  }
  throw new Error(`All providers failed: ${errors.join(' | ')}`);
}

// Synthesise final answer — Gemini preferred (bigger context), fallback Groq
async function synthesise(messages, systemPrompt) {
  const errors = [];
  for (const fn of [callGemini, callGroq]) {
    try { return await fn(messages, systemPrompt, null); }
    catch (e) { errors.push(e.message); }
  }
  throw new Error(`Synthesis failed: ${errors.join(' | ')}`);
}

// ── AGENT TOOL DEFINITIONS ───────────────────────────────────────────
const tools = [
  { type: 'function', function: { name: 'read_gmail',         description: 'Check recent emails.',           parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_calendar',      description: 'Check upcoming meetings.',       parameters: { type: 'object', properties: { timeframe: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_tasks',         description: 'Fetch pending tasks.',           parameters: { type: 'object', properties: { status: { type: 'string' } } } } },
  { type: 'function', function: { name: 'create_task',        description: 'Create a new task.',             parameters: { type: 'object', properties: { title: { type: 'string' }, notes: { type: 'string' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'search_google_drive',description: 'Search Drive for files.',        parameters: { type: 'object', properties: { searchQuery: { type: 'string' } }, required: ['searchQuery'] } } },
  { type: 'function', function: { name: 'read_google_doc',    description: 'Read full text of a Google Doc.',parameters: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] } } },
  { type: 'function', function: { name: 'read_google_sheets', description: 'Read data from a spreadsheet.', parameters: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' } }, required: ['spreadsheetId'] } } }
];

const systemPrompt = `You are Mimo, an elite AI assistant connected to Google Workspace.
RULES:
1. Be direct and concise.
2. Never mention which tools or APIs you used.
3. Give the answer directly — no preamble, no JSON in the response.
4. For lists, use clean bullet points.`;

// ── STEP 1: Intent detection — uses Groq (fast, cheap) ──────────────
async function determineIntentAndAsk(question, history) {
  const messages = [...history.slice(-4), { role: 'user', content: question }];
  const aiRes = await askAny(messages, systemPrompt, tools);

  if (aiRes.action === 'text') return { intent: 'ANSWER', answer: aiRes.text };

  return {
    intent: 'SEARCH',
    toolCalls: aiRes.calls,
    rawMessage: aiRes.rawMessage,
    messages
  };
}

// ── STEP 2: Execute tools with smart provider routing ────────────────
async function executeAgentSearch(intentData, googleAccessToken) {
  const { toolCalls, rawMessage, messages } = intentData;
  const sourcesUsed = [];

  // Small-context tools  → Groq handles synthesis
  const GROQ_TOOLS  = new Set(['read_gmail', 'read_calendar', 'read_tasks', 'create_task', 'read_google_sheets']);
  // Large-context tools  → Gemini handles synthesis
  const GEMINI_TOOLS = new Set(['search_google_drive', 'read_google_doc']);

  // Track which provider family was used so we can route synthesis correctly
  let usedLargeContext = false;

  const toolResults = await Promise.all(toolCalls.map(async (call) => {
    const { name, input, id } = call;
    try {
      // ── Small-context tools (Groq) ───────────────────────────────
      if (name === 'read_gmail') {
        sourcesUsed.push('Gmail');
        const emails = await getRecentEmails(googleAccessToken, 15);
        // 500 chars per email keeps total well under Groq's 12k limit
        const truncated = emails.map(e => ({ ...e, body: (e.body || e.snippet || '').substring(0, 500) }));
        return { id, name, resultData: formatEmailsForContext(truncated) };
      }

      if (name === 'read_calendar') {
        sourcesUsed.push('Calendar');
        return { id, name, resultData: formatEventsForContext(await getUpcomingEvents(googleAccessToken, 10)) };
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
        return { id, name, resultData: formatSheetForContext(await readSheetRange(googleAccessToken, input.spreadsheetId, input.range || 'A1:Z50')) };
      }

      // ── Large-context tools (Gemini) ─────────────────────────────
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
        // Gemini can handle up to ~500k chars comfortably; 80k is a safe cap
        return { id, name, resultData: docContent.substring(0, 80000) };
      }

      return { id, name, resultData: 'Unknown tool' };
    } catch (err) {
      return { id, name, resultData: `Error: ${err.message}` };
    }
  }));

  // ── Error check ───────────────────────────────────────────────────
  const toolErrors = toolResults.filter(tr => tr.resultData.startsWith('Error'));
  if (toolErrors.length > 0) {
    return { answer: `I had trouble accessing your data: ${toolErrors[0].resultData}`, source: 'Error' };
  }

  // ── Final synthesis ───────────────────────────────────────────────
  // If we read a doc or searched Drive, use Gemini (big context).
  // Otherwise use Groq (faster for small structured data).
  const finalMessages = [
    ...messages,
    rawMessage,
    ...toolResults.map(tr => ({ role: 'tool', tool_call_id: tr.id, name: tr.name, content: tr.resultData }))
  ];

  let finalRes;
  if (usedLargeContext) {
    // Gemini first (it can handle the full doc), fall back to Groq with truncation
    try {
      finalRes = await callGemini(finalMessages, systemPrompt, null);
    } catch (e) {
      console.warn('Gemini synthesis failed, falling back to Groq with truncation:', e.message);
      // Truncate doc content so Groq can handle it
      const truncatedMessages = finalMessages.map(m => {
        if (m.role === 'tool' && m.content && m.content.length > 3000) {
          return { ...m, content: m.content.substring(0, 3000) + '\n...[truncated]' };
        }
        return m;
      });
      finalRes = await callGroq(truncatedMessages, systemPrompt, null);
    }
  } else {
    // Small data — Groq first, Gemini as fallback
    try {
      finalRes = await callGroq(finalMessages, systemPrompt, null);
    } catch (e) {
      console.warn('Groq synthesis failed, falling back to Gemini:', e.message);
      finalRes = await callGemini(finalMessages, systemPrompt, null);
    }
  }

  return {
    answer: finalRes.text || 'Processed successfully.',
    source: [...new Set(sourcesUsed)].join(', ')
  };
}

module.exports = { determineIntentAndAsk, executeAgentSearch };