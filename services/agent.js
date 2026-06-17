// ── Import ALL Services ──
const { getRecentEmails, formatEmailsForContext } = require('./gmail');
const { getUpcomingEvents, formatEventsForContext } = require('./calendar');
const { searchDriveFiles, readGoogleDoc, formatFilesForContext } = require('./drive');
const { readSheetRange, formatSheetForContext } = require('./sheets');
const { getTasks, createTask, formatTasksForContext } = require('./tasks');

// ── UNIVERSAL AI CALLER (Groq -> Gemini -> OpenAI -> Claude) ───────
async function askUnifiedAI(messages, systemPrompt, tools) {
  const errors = [];

  if (process.env.GROQ_API_KEY) {
    try { 
      return await callOpenAICompatible('https://api.groq.com/openai/v1/chat/completions', process.env.GROQ_API_KEY, 'llama-3.3-70b-versatile', messages, tools, systemPrompt); 
    } catch (e) { errors.push(`Groq: ${e.message}`); }
  }

  if (process.env.GEMINI_API_KEY) {
    try { 
      return await callOpenAICompatible('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', process.env.GEMINI_API_KEY, 'gemini-1.5-pro', messages, tools, systemPrompt); 
    } catch (e) { errors.push(`Gemini: ${e.message}`); }
  }

  if (process.env.OPENAI_API_KEY) {
    try { return await callOpenAICompatible('https://api.openai.com/v1/chat/completions', process.env.OPENAI_API_KEY, 'gpt-4o-mini', messages, tools, systemPrompt); } 
    catch (e) { errors.push(`OpenAI: ${e.message}`); }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try { return await callAnthropicNative(process.env.ANTHROPIC_API_KEY, messages, tools, systemPrompt); } 
    catch (e) { errors.push(`Anthropic: ${e.message}`); }
  }

  throw new Error(`All AI providers failed. Details: ${errors.join(' | ')}`);
}

// ── AI HELPERS ───────────────────────────────────────────────────────
async function callOpenAICompatible(url, apiKey, model, messages, tools, systemPrompt) {
  const body = { model: model, messages: [{ role: "system", content: systemPrompt }, ...messages], temperature: 0 };
  
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
    if (url.includes('groq')) body.parallel_tool_calls = false;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(await res.text());
  
  const data = await res.json();
  const msg = data.choices[0].message;

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    return {
      action: 'tool_calls',
      calls: msg.tool_calls.map(tc => ({ id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) })),
      rawMessage: msg
    };
  }
  return { action: 'text', text: msg.content || "" };
}

async function callAnthropicNative(apiKey, messages, tools, systemPrompt) {
  const { Anthropic } = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey });

  const anthropicMessages = [];
  for (const m of messages) {
    if (m.role === 'user') anthropicMessages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant' && m.tool_calls) {
      anthropicMessages.push({ role: 'assistant', content: m.tool_calls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) })) });
    } else if (m.role === 'tool') {
      anthropicMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] });
    } else if (m.role === 'assistant') {
      anthropicMessages.push({ role: 'assistant', content: m.content });
    }
  }

  const options = { model: "claude-3-5-sonnet-20241022", max_tokens: 1024, system: systemPrompt, messages: anthropicMessages };
  if (tools && tools.length > 0) options.tools = tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));

  const response = await anthropic.messages.create(options);
  const toolCalls = response.content.filter(block => block.type === 'tool_use');
  
  if (toolCalls.length > 0) {
    return {
      action: 'tool_calls',
      calls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
      rawMessage: { role: 'assistant', tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })) }
    };
  }
  return { action: 'text', text: response.content.find(block => block.type === 'text')?.text || "" };
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

const systemPrompt = `You are Mimo, an elite AI assistant connected to Google Workspace. 
CRITICAL RULES:
1. Be extremely concise. 
2. Never explain what tools you used. 
3. Provide the final answer directly.
4. If using a tool, ONLY output the JSON tool call, absolutely no conversational text around it.`;

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
      if (name === 'create_task') { sourcesUsed.push('Tasks (Executed)'); const newTask = await createTask(googleAccessToken, input.title, input.notes || ''); return { id, name, resultData: `Success: Task "${newTask.title}" created.` }; }
      if (name === 'search_google_drive') { sourcesUsed.push('Drive Search'); return { id, name, resultData: formatFilesForContext(await searchDriveFiles(googleAccessToken, input.searchQuery, 5)) }; }
      if (name === 'read_google_doc') { sourcesUsed.push('Google Docs'); return { id, name, resultData: await readGoogleDoc(googleAccessToken, input.fileId) }; }
      if (name === 'read_google_sheets') { sourcesUsed.push('Sheets'); return { id, name, resultData: formatSheetForContext(await readSheetRange(googleAccessToken, input.spreadsheetId, input.range)) }; }
      return { id, name, resultData: "Unknown tool" };
    } catch (err) { return { id, name, resultData: `Error: ${err.message}` }; }
  }));

  const toolErrors = toolResults.filter(tr => tr.resultData.startsWith('Error'));
  if (toolErrors.length > 0) return { answer: `I had trouble accessing your data. Please check if the ${toolErrors[0].name} tool is authorized.`, source: 'Error' };

  const finalRes = await askUnifiedAI([...messages, rawMessage, ...toolResults.map(tr => ({ role: "tool", tool_call_id: tr.id, name: tr.name, content: tr.resultData }))], systemPrompt, null);

  return { answer: finalRes.text || "I checked that for you, but didn't generate a text summary.", source: [...new Set(sourcesUsed)].join(', ') || 'Mimo Agent' };
}

module.exports = { determineIntentAndAsk, executeAgentSearch };