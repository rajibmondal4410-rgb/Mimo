const express = require('express');
const router  = express.Router();
const authMiddleware                              = require('../middleware/auth');
const { getRecentEmails, formatEmailsForContext } = require('../services/gmail');
const { askAI }                                   = require('../services/claude'); // Updated import

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

  try {
    let context = '';
    let source  = null;

    // ── Detect if question is about Gmail ────────────────
    const needsGmail = /email|mail|inbox|gmail|sent|unread|message|who.*(email|wrote|send)/i.test(question);

    if (needsGmail) {
      if (!googleAccessToken) {
        return res.status(400).json({ error: 'Gmail not connected. Please login again.' });
      }
      try {
        const emails = await getRecentEmails(googleAccessToken, 15);
        context = formatEmailsForContext(emails);
        source  = 'Gmail';
      } catch (gmailErr) {
        // Token might be expired — tell user to re-login
        if (gmailErr.code === 401 || gmailErr.status === 401) {
          return res.status(401).json({ error: 'Gmail access expired. Please login again.' });
        }
        // For other errors, still try to answer without email context
        console.error('Gmail fetch error:', gmailErr.message);
        context = '[Could not fetch emails — Gmail API error]';
        source  = 'Gmail (error)';
      }
    }

    // ── Ask AI ───────────────────────────────────────
    const answer = await askAI({ // Updated function call
      question,
      context,
      history,
      contextSource: source || 'General',
    });

    res.json({ answer, source });

  } catch (err) {
    console.error('Ask route error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;