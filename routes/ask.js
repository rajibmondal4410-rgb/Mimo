const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth');
const { Anthropic } = require('@anthropic-ai/sdk');

// ── Import ALL Services (Keeping every feature + Read Doc) ─────────
const { getRecentEmails, formatEmailsForContext } = require('../services/gmail');
const { getUpcomingEvents, formatEventsForContext } = require('../services/calendar');
const { searchDriveFiles, readGoogleDoc, formatFilesForContext } = require('../services/drive');
const { readSheetRange, formatSheetForContext } = require('../services/sheets');
const { getTasks, createTask, formatTasksForContext } = require('../services/tasks');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.post('/', authMiddleware, async (req, res) => {
  const { question, history = [] } = req.body;
  const { googleAccessToken } = req.user;

  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }

  if (!googleAccessToken) {
    return res.status(400).json({ error: 'Google account not connected. Please login again.' });
  }

  try {
    // 1. Give Claude its full "Toolbelt"
    const tools = [
      {
        name: "read_gmail",
        description: "Check the user's recent emails, inbox, or see who emailed them.",
        input_schema: { type: "object", properties: {} }
      },
      {
        name: "read_calendar",
        description: "Check the user's upcoming meetings and schedule.",
        input_schema: { type: "object", properties: {} }
      },
      {
        name: "read_tasks",
        description: "Fetch the user's pending to-do list items from Google Tasks.",
        input_schema: { type: "object", properties: {} }
      },
      {
        name: "create_task",
        description: "Add a new task or reminder to the user's Google Tasks list.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string", description: "The title of the task." },
            notes: { type: "string", description: "Optional details or notes." }
          },
          required: ["title"]
        }
      },
      {
        name: "search_google_drive",
        description: "Search Google Drive to find a file's name, link, and ID.",
        input_schema: {
          type: "object",
          properties: {
            searchQuery: { type: "string", description: "The term or phrase to search for." }
          },
          required: ["searchQuery"]
        }
      },
      {
        name: "read_google_doc",
        description: "Opens a specific Google Doc and reads the exact text inside it to answer questions. Requires the fileId.",
        input_schema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "The Google Drive file ID to read." }
          },
          required: ["fileId"]
        }
      },
      {
        name: "read_google_sheets",
        description: "Reads data from a Google Spreadsheet to answer data questions.",
        input_schema: {
          type: "object",
          properties: {
            spreadsheetId: { type: "string", description: "The extracted ID of the spreadsheet." },
            range: { type: "string", description: "The cell range to read, e.g., 'A1:Z50'." }
          },
          required: ["spreadsheetId"]
        }
      }
    ];

    // The prompt tells Claude HOW to behave with the data it finds
    const systemPrompt = "You are Mimo, a highly capable AI assistant connected to the user's Google Workspace. You have tools to search for files, read inside documents, read spreadsheets, and check emails/tasks. If a user asks a question about information inside a document, use 'search_google_drive' to find the fileId, and then use 'read_google_doc' to read the actual text and answer their question. Always provide the actual answer, not just a link. Explicitly state where you found the information (e.g., 'According to the Q3 Project Doc...' or 'Found in row 4 of your Sheet...').";

    const messages = [...history.slice(-4), { role: "user", content: question }];

    // 2. Initial call: Claude decides what tools to use
    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: systemPrompt,
      tools: tools,
      messages: messages
    });

    const toolCalls = response.content.filter(block => block.type === 'tool_use');

    if (toolCalls.length === 0) {
      const textBlock = response.content.find(block => block.type === 'text');
      return res.json({ answer: textBlock ? textBlock.text : "I couldn't process that.", source: 'General' });
    }

    const sourcesUsed = [];

    // 3. PARALLEL EXECUTION: Run tools
    const toolResults = await Promise.all(toolCalls.map(async (toolCall) => {
      const { name, input, id } = toolCall;
      let resultData = '';

      try {
        if (name === 'read_gmail') {
          const emails = await getRecentEmails(googleAccessToken, 15);
          resultData = formatEmailsForContext(emails);
          sourcesUsed.push('Gmail');
        } 
        else if (name === 'read_calendar') {
          const events = await getUpcomingEvents(googleAccessToken, 10);
          resultData = formatEventsForContext(events);
          sourcesUsed.push('Calendar');
        }
        else if (name === 'read_tasks') {
          const tasks = await getTasks(googleAccessToken, 15);
          resultData = formatTasksForContext(tasks);
          sourcesUsed.push('Tasks');
        }
        else if (name === 'create_task') {
          const newTask = await createTask(googleAccessToken, input.title, input.notes || '');
          resultData = `System Confirmation: Successfully created task "${newTask.title}".`;
          sourcesUsed.push('Tasks (Executed)');
        }
        else if (name === 'search_google_drive') {
          const files = await searchDriveFiles(googleAccessToken, input.searchQuery, 5);
          resultData = formatFilesForContext(files);
          sourcesUsed.push('Drive Search');
        } 
        else if (name === 'read_google_doc') {
          const textContent = await readGoogleDoc(googleAccessToken, input.fileId);
          resultData = `Document Content:\n\n${textContent}`;
          sourcesUsed.push('Google Docs');
        }
        else if (name === 'read_google_sheets') {
          const rows = await readSheetRange(googleAccessToken, input.spreadsheetId, input.range || 'A1:Z50');
          resultData = formatSheetForContext(rows);
          sourcesUsed.push('Sheets');
        }
      } catch (err) {
        console.error(`Error running tool ${name}:`, err.message);
        resultData = `Error executing tool: ${err.message}`;
      }

      return {
        type: "tool_result",
        tool_use_id: id,
        content: resultData
      };
    }));

    const uniqueSources = [...new Set(sourcesUsed)].join(', ');

    // 4. Send the fetched data back to Claude so it can read it and answer you
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    const finalResponse = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: systemPrompt,
      tools: tools,
      messages: messages
    });

    const finalTextBlock = finalResponse.content.find(block => block.type === 'text');
    
    res.json({ 
      answer: finalTextBlock ? finalTextBlock.text : "Search complete, but no text summary was generated.", 
      source: uniqueSources || 'Mimo Agent' 
    });

  } catch (err) {
    if (err.status === 401 || err.code === 401) {
       return res.status(401).json({ error: 'Access token expired. Please reconnect Google.' });
    }
    console.error('Agent loop error:', err.message);
    res.status(500).json({ error: 'Something went wrong processing that request.' });
  }
});

module.exports = router;