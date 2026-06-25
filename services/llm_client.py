import os
import httpx
from typing import List, Dict, Any, Optional

# ── Model names per provider ───────────────────────────
MODELS = {
    "groq": "llama-3.3-70b-versatile",
    "gemini": "gemini-2.0-flash", # Or gemini-1.5-flash-latest depending on your preference
}

def build_system_prompt(context: Optional[str], context_source: Optional[str]) -> str:
    """Builds the core instruction set for the AI."""
    base_prompt = """You are Mimo, a personal AI assistant embedded in a browser sidebar.
You help the user understand their data without switching tabs.

Rules:
- Be concise and direct. No fluff, no filler phrases.
- For email summaries: show sender, subject, one-sentence summary per email.
- For general questions: answer like a smart, helpful friend.
- Never make up email content. Only use what is provided in the context.
- If context is empty and question is about emails, say you couldn't fetch them."""

    if context and context_source:
        base_prompt += f"\n\nData from {context_source}:\n{context}"
        
    return base_prompt


async def ask_groq(question: str, context: Optional[str], history: List[Dict[str, str]], context_source: Optional[str]) -> str:
    """Calls the Groq API via standard HTTP."""
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise ValueError("No GROQ_API_KEY found")

    system_prompt = build_system_prompt(context, context_source)
    messages = [{"role": "system", "content": system_prompt}] + history[-6:] + [{"role": "user", "content": question}]

    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": MODELS["groq"], "messages": messages, "temperature": 0.3}
        )
        res.raise_for_status()
        return res.json()["choices"][0]["message"]["content"]


async def ask_gemini(question: str, context: Optional[str], history: List[Dict[str, str]], context_source: Optional[str]) -> str:
    """Calls the Gemini API using their OpenAI-compatible endpoint."""
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("No GEMINI_API_KEY found")

    system_prompt = build_system_prompt(context, context_source)
    messages = [{"role": "system", "content": system_prompt}] + history[-6:] + [{"role": "user", "content": question}]

    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": MODELS["gemini"], "messages": messages, "temperature": 0.3}
        )
        res.raise_for_status()
        return res.json()["choices"][0]["message"]["content"]


async def ask_ai(question: str, context: Optional[str] = None, history: List[Dict[str, str]] = None, context_source: Optional[str] = None) -> str:
    """
    The Fallback Engine.
    Attempts Groq first. If it fails, catches the error and seamlessly routes to Gemini.
    """
    if history is None:
        history = []

    sequence = [
        {"id": "groq", "call": ask_groq, "key": os.getenv("GROQ_API_KEY")},
        {"id": "gemini", "call": ask_gemini, "key": os.getenv("GEMINI_API_KEY")}
    ]

    # Filter out any providers where the API key is missing
    available = [p for p in sequence if p["key"]]

    if not available:
        raise RuntimeError("No AI provider keys found in .env (Need GROQ_API_KEY or GEMINI_API_KEY)")

    last_error = None

    for provider in available:
        try:
            print(f"\n🔄 Routing to: {provider['id']}...")
            
            # Execute the specific provider function
            answer = await provider["call"](question, context, history, context_source)
            
            print(f"✅ Success: {provider['id']} handled the request.")
            return answer
            
        except Exception as err:
            print(f"⚠️ {provider['id']} failed ({str(err)}). Switching to next provider...")
            last_error = err

    # If both fail (e.g., total API outage or rate limits exceeded)
    raise RuntimeError(f"All configured AI providers failed. Last error: {str(last_error)}")

# ── Log the active chain on startup ──
try:
    keys = {"GROQ_API_KEY": "groq", "GEMINI_API_KEY": "gemini"}
    active_chain = [name for env_key, name in keys.items() if os.getenv(env_key)]
    if active_chain:
        print(f"✅ AI Fallback Chain Loaded: {' ➔ '.join(active_chain)}")
except Exception:
    pass