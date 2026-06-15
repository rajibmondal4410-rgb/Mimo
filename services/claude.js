/**
 * services/claude.js — Multi-provider AI Fallback Service
 *
 * Sequence: Anthropic ➔ Groq ➔ Gemini ➔ OpenAI
 * It will try the first available provider. If it fails, it automatically
 * catches the error and tries the next one in the chain.
 */

const Anthropic = require('@anthropic-ai/sdk');
const Groq = require('groq-sdk');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Model names per provider ───────────────────────────
const MODELS = {
  anthropic: 'claude-sonnet-4-20250514',
  groq:      'llama-3.3-70b-versatile',
  gemini:    'gemini-1.5-flash-latest', // <-- Changed this line
  openai:    'gpt-4o-mini',
};

// ── System prompt (same for all providers) ─────────────
function buildSystemPrompt(context, contextSource) {
  return `You are Mimo, a personal AI assistant embedded in a browser sidebar.
You help the user understand their data without switching tabs.

Rules:
- Be concise and direct. No fluff, no filler phrases.
- For email summaries: show sender, subject, one-sentence summary per email.
- For general questions: answer like a smart, helpful friend.
- Never make up email content. Only use what is provided in the context.
- If context is empty and question is about emails, say you couldn't fetch them.
${context ? `\n\nData from ${contextSource}:\n${context}` : ''}`;
}

// ── Anthropic ──────────────────────────────────────────
async function askAnthropic({ question, context, history, contextSource }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model:      MODELS.anthropic,
    max_tokens: 1024,
    system:     buildSystemPrompt(context, contextSource),
    messages: [
      ...history.slice(-6),
      { role: 'user', content: question },
    ],
  });
  return response.content[0].text;
}

// ── Groq ───────────────────────────────────────────────
async function askGroq({ question, context, history, contextSource }) {
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const response = await client.chat.completions.create({
    model:      MODELS.groq,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: buildSystemPrompt(context, contextSource) },
      ...history.slice(-6),
      { role: 'user', content: question },
    ],
  });
  return response.choices[0].message.content;
}

// ── Gemini ─────────────────────────────────────────────
async function askGemini({ question, context, history, contextSource }) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model:             MODELS.gemini,
    systemInstruction: buildSystemPrompt(context, contextSource),
  });

  const geminiHistory = history.slice(-6).map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const chat   = model.startChat({ history: geminiHistory });
  const result = await chat.sendMessage(question);
  return result.response.text();
}

// ── OpenAI ─────────────────────────────────────────────
async function askOpenAI({ question, context, history, contextSource }) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model:      MODELS.openai,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: buildSystemPrompt(context, contextSource) },
      ...history.slice(-6),
      { role: 'user', content: question },
    ],
  });
  return response.choices[0].message.content;
}

// ── Fallback Engine ────────────────────────────────────
async function askAI(params) {
  // Define the exact order of fallback
  const sequence = [
    { id: 'anthropic', call: askAnthropic, key: process.env.ANTHROPIC_API_KEY },
    { id: 'groq',      call: askGroq,      key: process.env.GROQ_API_KEY },
    { id: 'gemini',    call: askGemini,    key: process.env.GEMINI_API_KEY },
    { id: 'openai',    call: askOpenAI,    key: process.env.OPENAI_API_KEY }
  ];

  // Filter out any providers where you haven't added an API key in .env
  const available = sequence.filter(p => !!p.key);

  if (available.length === 0) {
    throw new Error('No AI provider keys found in .env');
  }

  let lastError = null;

  // Try each provider one by one
  for (const provider of available) {
    try {
      console.log(`\n🔄 Routing to: ${provider.id}...`);
      const answer = await provider.call(params);
      console.log(`✅ Success: ${provider.id} handled the request.`);
      return answer; // If successful, exit the loop and return the answer
    } catch (err) {
      console.warn(`⚠️ ${provider.id} failed (${err.message}). Switching to next provider...`);
      lastError = err;
      // Loop automatically continues to the next available provider
    }
  }

  // If ALL available providers fail, throw the final error
  throw new Error(`All configured AI providers failed. Last error: ${lastError.message}`);
}

// ── Log the active chain on startup ────────────────────
try {
  const keys = ['ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'];
  const activeChain = keys.filter(k => process.env[k]).map(k => k.split('_')[0].toLowerCase());
  console.log(`✅ AI Fallback Chain Loaded: ${activeChain.join(' ➔ ')}`);
} catch (e) {
  // Ignore startup log errors
}

module.exports = { askAI };