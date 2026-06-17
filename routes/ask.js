const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth');

// Import the execution engine from our new agent file
const { determineIntentAndAsk, executeAgentSearch } = require('../services/agent');

router.post('/', authMiddleware, async (req, res) => {
  const { question, history = [] } = req.body;
  const { googleAccessToken } = req.user;

  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }

  if (!googleAccessToken) {
    return res.status(400).json({ error: 'Google account not connected.' });
  }

  try {
    // ── STEP 1: SPECIFY INTENT ───────────────────────────────────────
    // The AI decides if it can just talk, or if it needs to execute tools
    const intentData = await determineIntentAndAsk(question, history);

    // ── STEP 2: ACT ON INTENT ────────────────────────────────────────
    if (intentData.intent === 'ANSWER') {
      // General Chat — No searching needed
      return res.json({ 
        answer: intentData.answer, 
        source: 'General' 
      });
    }

    if (intentData.intent === 'SEARCH') {
      // Tool required — Pass to the Execution Engine
      const finalResult = await executeAgentSearch(intentData, googleAccessToken);
      return res.json({ 
        answer: finalResult.answer, 
        source: finalResult.source 
      });
    }

  } catch (err) {
    if (err.status === 401 || err.code === 401) {
      return res.status(401).json({ error: 'Access token expired. Please reconnect Google.' });
    }
    console.error('Ask route error:', err.message);
    res.status(500).json({ error: 'Something went wrong processing that request.' });
  }
});

module.exports = router;