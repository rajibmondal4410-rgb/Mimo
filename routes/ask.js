const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth');

// ── Import ALL Services (Keeping every feature + Read Doc) ─────────
const { getRecentEmails, formatEmailsForContext } = require('../services/gmail');
const { getUpcomingEvents, formatEventsForContext } = require('../services/calendar');
const { searchDriveFiles, readGoogleDoc, formatFilesForContext } = require('../services/drive');
const { readSheetRange, formatSheetForContext } = require('../services/sheets');
const { getTasks, createTask, formatTasksForContext } = require('../services/tasks');

// ── UNIVERSAL AI CALLER (Groq -> Gemini -> OpenAI -> Claude) ───────
// This function automatically tries your available API keys in order.
async function askUnifiedAI(messages, systemPrompt, tools) {
  const errors = [];

  // 1. Try Groq (Ultra-fast Llama 3.3)
  if (process.env.GROQ_API_KEY) {
    try {
      return await callOpenAICompatible('https://api.groq.com/openai/v1/chat/completions', process.env.GROQ_API_KEY, 'llama-3.3-70b-versatile', messages, tools, systemPrompt);
    } catch (e) { errors.push(`Groq: ${e.message}`); }
  }

  // 2. Try Gemini (via its official OpenAI-compatibility layer)
  if (process.env.GEMINI_API_KEY) {
    try {
      return await callOpenAICompatible('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', process.env.GEMINI_API_KEY, 'gemini-1.5-pro', messages, tools, systemPrompt);
    } catch (e) { errors.push(`Gemini: ${e.message}`); }
  }

  // 3. Try OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      return await callOpenAICompatible('https://api.openai.com/v1/chat/completions', process.env.OPENAI_API_KEY, 'gpt-4o-mini', messages, tools, systemPrompt);
    } catch (e) { errors.push(`OpenAI: ${e.message}`); }
  }

  // 4. Try Anthropic (Claude)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await callAnthropicNative(process.env.ANTHROPIC_API_KEY, messages, tools, systemPrompt);
    } catch (e) { errors.push(`Anthropic: ${e.message}`); }
  }

  throw new Error(`All configured AI providers failed. Details: ${errors.join(' | ')}`);
}

// Helper to call OpenAI, Groq, or Gemini flawlessly using standard fetch
async function callOpenAICompatible(url, apiKey, model, messages, tools, systemPrompt) {
  const body = {
    model: model,
    messages: [{ role: "system", content: systemPrompt }, ...messages]
  };

  // ONLY attach tools if they are provided. This forces the AI to output text on the final pass.
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
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
      calls: msg.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments)
      })),
      rawMessage: msg
    };
  }
  return { action: 'text', text: msg.content || "" };
}

// Helper to safely call Claude ONLY if the key exists (prevents startup crashes)
async function callAnthropicNative(apiKey, messages, tools, systemPrompt) {
  const { Anthropic } = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey });

  const anthropicMessages = [];
  for (const m of messages) {
    if (m.role === 'user') anthropicMessages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant' && m.tool_calls) {
      anthropicMessages.push({
        role: 'assistant',
        content: m.tool_calls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) }))
      });
    } else if (m.role === 'tool') {
      anthropicMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] });
    } else if (m.role === 'assistant') {
      anthropicMessages.push({ role: 'assistant', content: m.content });
    }
  }

  const options = {
    model: "claude-3-5-sonnet-20241022", max_tokens: 1024, system: systemPrompt, messages: anthropicMessages
  };

  if (tools && tools.length > 0) {
    options.tools = tools.map(t => ({
      name: t.function.name, description: t.function.description, input_schema: t.function.parameters
    }));
  }

  const response = await anthropic.messages.create(options);

  const toolCalls = response.content.filter(block => block.type === 'tool_use');
  if (toolCalls.length > 0) {
    return {
      action: 'tool_calls',
      calls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
      rawMessage: {
        role: 'assistant',
        tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } }))
      }
    };
  }
  return { action: 'text', text: response.content.find(block => block.type === 'text')?.text || "" };
}

// ── ROUTE LOGIC ──────────────────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  const { question, history = [] } = req.body;
  const { googleAccessToken } = req.user;

  if (!question || !question.trim()) return res.status(400).json({ error: 'Question is required' });
  if (!googleAccessToken) return res.status(400).json({ error: 'Google account not connected.' });

  try {
    // Standardized Universal Tool format
    const tools = [
      { type: "function", function: { name: "read_gmail", description: "Check recent emails, inbox, or see who emailed.", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "read_calendar", description: "Check upcoming meetings and schedule.", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "read_tasks", description: "Fetch pending to-do list items.", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "create_task", description: "Add a new task or reminder.", parameters: { type: "object", properties: { title: { type: "string" }, notes: { type: "string" } }, required: ["title"] } } },
      { type: "function", function: { name: "search_google_drive", description: "Search Google Drive to find a file's name, link, and ID.", parameters: { type: "object", properties: { searchQuery: { type: "string" } }, required: ["searchQuery"] } } },
      { type: "function", function: { name: "read_google_doc", description: "Opens a Google Doc to read text. Requires fileId.", parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] } } },
      { type: "function", function: { name: "read_google_sheets", description: "Reads data from a Spreadsheet.", parameters: { type: "object", properties: { spreadsheetId: { type: "string" }, range: { type: "string" } }, required: ["spreadsheetId"] } } }
    ];

    const systemPrompt = "You are Mimo, a highly capable AI assistant connected to Google Workspace. You have tools to search files, read documents, spreadsheets, and check emails/tasks. If asked about a document's info, use 'search_google_drive' to get the fileId, then 'read_google_doc' to answer. Provide exact answers, explicitly stating where you found them. IMPORTANT: After using tools, you MUST provide a conversational text answer to the user.";

    const messages = [...history.slice(-4), { role: "user", content: question }];

    // 1. Initial AI Call (Will try Groq -> Gemini -> OpenAI -> Claude)
    const aiRes = await askUnifiedAI(messages, systemPrompt, tools);

    if (aiRes.action === 'text') {
      return res.json({ answer: aiRes.text, source: 'General' });
    }

    // 2. Execute Tools
    const sourcesUsed = [];
    const toolResults = await Promise.all(aiRes.calls.map(async (call) => {
      const { name, input, id } = call;
      let resultData = '';

      try {
        if (name === 'read_gmail') {
          resultData = formatEmailsForContext(await getRecentEmails(googleAccessToken, 15));
          sourcesUsed.push('Gmail');
        } else if (name === 'read_calendar') {
          resultData = formatEventsForContext(await getUpcomingEvents(googleAccessToken, 10));
          sourcesUsed.push('Calendar');
        } else if (name === 'read_tasks') {
          resultData = formatTasksForContext(await getTasks(googleAccessToken, 15));
          sourcesUsed.push('Tasks');
        } else if (name === 'create_task') {
          const newTask = await createTask(googleAccessToken, input.title, input.notes || '');
          resultData = `System Confirmation: Task "${newTask.title}" created.`;
          sourcesUsed.push('Tasks (Executed)');
        } else if (name === 'search_google_drive') {
          resultData = formatFilesForContext(await searchDriveFiles(googleAccessToken, input.searchQuery, 5));
          sourcesUsed.push('Drive Search');
        } else if (name === 'read_google_doc') {
          resultData = `Document Content:\n\n${await readGoogleDoc(googleAccessToken, input.fileId)}`;
          sourcesUsed.push('Google Docs');
        } else if (name === 'read_google_sheets') {
          resultData = formatSheetForContext(await readSheetRange(googleAccessToken, input.spreadsheetId, input.range || 'A1:Z50'));
          sourcesUsed.push('Sheets');
        }
      } catch (err) {
        console.error(`Tool error ${name}:`, err.message);
        resultData = `Error executing tool: ${err.message}`;
      }
      return { id, name, resultData };
    }));

    // 3. Feed the executed data back to AI for the final answer
    messages.push(aiRes.rawMessage);
    for (const tr of toolResults) {
      messages.push({ role: "tool", tool_call_id: tr.id, name: tr.name, content: tr.resultData });
    }

    // CRITICAL FIX: Pass 'null' for tools here so the AI is forced to answer with text
    const finalRes = await askUnifiedAI(messages, systemPrompt, null);

    res.json({ 
      answer: finalRes.action === 'text' && finalRes.text.trim() ? finalRes.text : "I checked that for you, but didn't generate a text summary.", 
      source: [...new Set(sourcesUsed)].join(', ') || 'Mimo Agent' 
    });

  } catch (err) {
    if (err.status === 401 || err.code === 401) return res.status(401).json({ error: 'Access token expired. Please reconnect Google.' });
    console.error('Agent loop error:', err.message);
    res.status(500).json({ error: 'Something went wrong processing that request.' });
  }
});

module.exports = router;