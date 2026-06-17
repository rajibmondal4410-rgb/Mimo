// backend/routes/ask.js
const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth');

// ── Import All Services ──────────────────────────────────
const { getRecentEmails, formatEmailsForContext } = require('../services/gmail');
const { getUpcomingEvents, formatEventsForContext } = require('../services/calendar');
const { searchDriveFiles, readGoogleDoc, formatFilesForContext } = require('../services/drive');
const { readSheetRange, getSpreadsheetMeta, formatSheetForContext } = require('../services/sheets');
const { getTasks, createTask, formatTasksForContext } = require('../services/tasks');
const { askAI } = require('../services/claude');

/**
 * POST /ask
 * Body: { question: string, history: Array }
 * Header: Authorization: Bearer <jwt>
 */
router.post('/', authMiddleware, async (req, res) => {
  const { question, history = [] } = req.body;

  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }

  const { googleAccessToken } = req.user;
  
  if (!googleAccessToken) {
    return res.status(400).json({ error: 'Google account not connected. Please login again.' });
  }

  try {
    let context = '';
    let source  = 'General';

    const normalizedQuery = question.toLowerCase();

    // ── 1. AGENTIC EXECUTION: Create Google Task ──────────
    if (normalizedQuery.includes('add task') || normalizedQuery.includes('create task') || normalizedQuery.includes('remind me to')) {
      // Simple intent extraction from text
      const cleanTaskText = question
        .replace(/add task|create task|remind me to/gi, '')
        .replace(/to\s+/i, '')
        .trim();
        
      const title = cleanTaskText || "New Task from Mimo";
      const notes = `Created via Mimo AI on ${new Date().toLocaleDateString()}`;

      try {
        const newTask = await createTask(googleAccessToken, title, notes);
        context = `[System Confirmation: Successfully created task "${newTask.title}" in user's Google Tasks]`;
        source = 'Google Tasks (Executed)';
      } catch (err) {
        console.error('Error creating task:', err.message);
        context = '[System Error: Attempted to create a task but the Google Tasks API failed]';
        source = 'Google Tasks (Error)';
      }
    }

    // ── 2. DATA INGESTION: Read Google Tasks ──────────────
    else if (normalizedQuery.includes('task') || normalizedQuery.includes('todo') || normalizedQuery.includes('to-do')) {
      try {
        const taskList = await getTasks(googleAccessToken, 15);
        context = formatTasksForContext(taskList);
        source = 'Google Tasks';
      } catch (err) {
        console.error('Error fetching tasks:', err.message);
        context = '[Could not fetch tasks — Google Tasks API error]';
        source = 'Google Tasks (Error)';
      }
    }

    // ── 3. DATA INGESTION: Google Calendar ────────────────
    else if (normalizedQuery.includes('calendar') || normalizedQuery.includes('meeting') || normalizedQuery.includes('schedule') || normalizedQuery.includes('today') || normalizedQuery.includes('tomorrow')) {
      try {
        const events = await getUpcomingEvents(googleAccessToken, 10);
        context = formatEventsForContext(events);
        source = 'Google Calendar';
      } catch (err) {
        console.error('Error fetching calendar:', err.message);
        context = '[Could not fetch calendar — Google Calendar API error]';
        source = 'Google Calendar (Error)';
      }
    }

    // ── 4. DATA INGESTION: Google Sheets ──────────────────
    else if (normalizedQuery.includes('sheet') || normalizedQuery.includes('spreadsheet') || normalizedQuery.includes('excel')) {
      // Extract a Spreadsheet ID if present inside the user's text
      const sheetIdMatch = question.match(/\/d\/([a-zA-Z0-9-_]+)/);
      const spreadsheetId = sheetIdMatch ? sheetIdMatch[1] : null;

      if (!spreadsheetId) {
        context = '[System Note: User asked about a sheet, but did not provide a full spreadsheet link or ID in their message. Asking user for the link.]';
        source = 'Google Sheets';
      } else {
        try {
          const rows = await readSheetRange(googleAccessToken, spreadsheetId, 'A1:Z50');
          context = formatSheetForContext(rows);
          source = 'Google Sheets';
        } catch (err) {
          console.error('Error reading sheet:', err.message);
          context = '[Could not read sheet data — Verify the spreadsheet link is correct and accessible]';
          source = 'Google Sheets (Error)';
        }
      }
    }

    // ── 5. DATA INGESTION: Google Drive & Docs ────────────
    else if (normalizedQuery.includes('drive') || normalizedQuery.includes('file') || normalizedQuery.includes('doc') || normalizedQuery.includes('search for')) {
      // Clean up search keywords for drive query
      const searchQuery = question.replace(/search drive for|find file|search for/gi, '').trim();
      
      try {
        const files = await searchDriveFiles(googleAccessToken, searchQuery || 'type = "document"', 5);
        context = formatFilesForContext(files);
        source = 'Google Drive';
      } catch (err) {
        console.error('Error searching drive:', err.message);
        context = '[Could not query Google Drive — API Error]';
        source = 'Google Drive (Error)';
      }
    }

    // ── 6. DATA INGESTION: Gmail (Your original logic) ───
    else if (/email|mail|inbox|gmail|sent|unread|message|who.*(email|wrote|send)/i.test(question)) {
      try {
        const emails = await getRecentEmails(googleAccessToken, 15);
        context = formatEmailsForContext(emails);
        source = 'Gmail';
      } catch (gmailErr) {
        if (gmailErr.code === 401 || gmailErr.status === 401) {
          return res.status(401).json({ error: 'Access token expired. Please login again.' });
        }
        console.error('Gmail fetch error:', gmailErr.message);
        context = '[Could not fetch emails — Gmail API error]';
        source = 'Gmail (Error)';
      }
    }

    // ── 7. Send Context and Request to Claude ─────────────
    const answer = await askAI({
      question,
      context,
      history,
      contextSource: source,
    });

    res.json({ answer, source });

  } catch (err) {
    console.error('Ask route execution error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;