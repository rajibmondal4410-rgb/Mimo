// ── Import ALL Services ──
const { getRecentEmails, formatEmailsForContext } = require('./gmail');
const { getUpcomingEvents, formatEventsForContext } = require('./calendar');
const { searchDriveFiles, readGoogleDoc, formatFilesForContext } = require('./drive');
const { readSheetRange, formatSheetForContext } = require('./sheets');
const { getTasks, createTask, formatTasksForContext } = require('./tasks');

// ── UNIVERSAL AI CALLER ───────
async function askUnifiedAI(messages, systemPrompt, tools) {
  const errors = [];
  const providers = [
    { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: 'llama-3.3-70b-versatile' },
    { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: process.env.GEMINI_API_KEY, model: 'gemini-1.5-pro' }
  ];

  for (const p of providers) {
    if (!p.key) continue;
    try {
      const body = { 
        model: p.model, 
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        temperature: 0 
      };
      if (tools) {
        body.tools = tools;
        body.tool_choice = "auto";
        if (p.name === 'Groq') body.parallel_tool_calls = false;
      }
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${p.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const msg = data.choices[0].message;
      if (msg.tool_calls?.length > 0) return { action: 'tool_calls', calls: msg.tool_calls.map(tc => ({ id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) })), rawMessage: msg };
      return { action: 'text', text: msg.content || "" };
    } catch (e) { errors.push(`${p.name}: ${e.message}`); }
  }
  throw new Error(`All providers failed: ${errors.join(' | ')}`);
}

// ── AGENT TOOL DEFINITIONS ───────────────────────────────────────────
const tools = [
  { type: "function", function: { name: "read_gmail", description: "Check recent emails.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_calendar", description: "Check meetings.", parameters: { type: "object", properties: { timeframe: { type: "string" } } } } },
  { type: "function", function: { name: "read_tasks", description: "Fetch tasks.", parameters: { type: "object", properties: { status: { type: "string" } } } } },
  { type: "function", function: { name: "create_task", description: "Add task.", parameters: { type: "object", properties: { title: { type: "string" }, notes: { type: "string" } }, required: ["title"] } } },
  { type: "function", function: { name: "search_google_drive", description: "Search Drive files.", parameters: { type: "object", properties: { searchQuery: { type: "string" } }, required: ["searchQuery"] } } },
  { type: "function", function: { name: "read_google_doc", description: "Read doc text.", parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] } } },
  { type: "function", function: { name: "read_google_sheets", description: "Read sheets.", parameters: { type: "object", properties: { spreadsheetId: { type: "string" }, range: { type: "string" } }, required: ["spreadsheetId"] } } }
];

const systemPrompt = `You are Mimo, an elite AI assistant. 
RULES: 
1. Be direct. 
2. Never mention tools used. 
3. Direct answers only. 
4. If using a tool, output straight to the point; no JSON, speak normally.`;

// ── EXPORTED CORE FUNCTIONS ──────────────────────────────────────────
async function determineIntentAndAsk(question, history) {
  const aiRes = await askUnifiedAI([...history.slice(-4), { role: "user", content: question }], systemPrompt, tools);
  return aiRes.action === 'text' ? { intent: 'ANSWER', answer: aiRes.text } : { intent: 'SEARCH', toolCalls: aiRes.calls, rawMessage: aiRes.rawMessage, messages: [...history.slice(-4), { role: "user", content: question }] };
}

async function executeAgentSearch(intentData, googleAccessToken) {
  const { toolCalls, rawMessage, messages } = intentData;
  const sourcesUsed = []; 

  const toolResults = await Promise.all(toolCalls.map(async (call) => {
    const { name, input, id } = call;
    try {
      if (name === 'read_gmail') { sourcesUsed.push('Gmail'); return { id, name, resultData: formatEmailsForContext(await getRecentEmails(googleAccessToken, 15)) }; }
      if (name === 'read_calendar') { sourcesUsed.push('Calendar'); return { id, name, resultData: formatEventsForContext(await getUpcomingEvents(googleAccessToken, 10)) }; }
      if (name === 'read_tasks') { sourcesUsed.push('Tasks'); return { id, name, resultData: formatTasksForContext(await getTasks(googleAccessToken, 15)) }; }
      if (name === 'create_task') { sourcesUsed.push('Tasks'); const newTask = await createTask(googleAccessToken, input.title, input.notes || ''); return { id, name, resultData: `Success: Task "${newTask.title}" created.` }; }
      if (name === 'search_google_drive') { sourcesUsed.push('Drive Search'); return { id, name, resultData: formatFilesForContext(await searchDriveFiles(googleAccessToken, input.searchQuery, 5)) }; }
      
      // Merged Document Validation Logic
      if (name === 'read_google_doc') { 
        sourcesUsed.push('Google Docs'); 
        const docContent = await readGoogleDoc(googleAccessToken, input.fileId);
        if (!docContent || docContent.length < 50) throw new Error("Could not read document content. The file might be empty or inaccessible.");
        return { id, name, resultData: docContent }; 
      }
      
      if (name === 'read_google_sheets') { sourcesUsed.push('Sheets'); return { id, name, resultData: formatSheetForContext(await readSheetRange(googleAccessToken, input.spreadsheetId, input.range)) }; }
      
      return { id, name, resultData: "Unknown tool" };
    } catch (err) { return { id, name, resultData: `Error: ${err.message}` }; }
  }));

  const toolErrors = toolResults.filter(tr => tr.resultData.startsWith('Error'));
  if (toolErrors.length > 0) return { answer: `I had trouble accessing data: ${toolErrors[0].resultData}`, source: 'Error' };

  // FINAL CALL: 'null' passed as 3rd argument forces NO JSON/Tool-Calling
  const finalRes = await askUnifiedAI([...messages, rawMessage, ...toolResults.map(tr => ({ role: "tool", tool_call_id: tr.id, name: tr.name, content: tr.resultData }))], systemPrompt, null);

  return { answer: finalRes.text || "Processed successfully.", source: [...new Set(sourcesUsed)].join(', ') };
}

module.exports = { determineIntentAndAsk, executeAgentSearch }