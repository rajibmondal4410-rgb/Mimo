require('dotenv').config();
const express = require('express');
const cors    = require('cors');

// ── Validate required env vars on startup ──────────────
const required = ['JWT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
const missing  = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌  Missing env vars:', missing.join(', '));
  console.error('   Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

// Check if at least one AI provider key exists
if (!process.env.ANTHROPIC_API_KEY && !process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
  console.error('❌  Missing AI API Key. Add ANTHROPIC_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY to your .env');
  process.exit(1);
}

const app = express();

app.use(cors({
  origin: '*', // extension can call from any origin
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// ── Routes ─────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));
app.use('/ask',  require('./routes/ask'));

// Health check — useful to verify deploy is alive
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'mimo-backend', version: '0.1.0' });
});

// ── 404 handler ────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ───────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
// Change your app.listen block to this:
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  Mimo backend running on http://127.0.0.1:${PORT}`);
  console.log(`    Health: http://127.0.0.1:${PORT}/health\n`);
});