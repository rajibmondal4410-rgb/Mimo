import os
import sys
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from routers import mail
from routers import voice

# Load environment variables from .env file
load_dotenv()

# ── Validate required env vars on startup ──────────────
REQUIRED_VARS = ['JWT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']
missing = [k for k in REQUIRED_VARS if not os.getenv(k)]

if missing:
    print(f"❌  Missing env vars: {', '.join(missing)}")
    print("   Copy .env.example to .env and fill in the values.")
    sys.exit(1)

# Check if at least one AI provider key exists
AI_KEYS = ['ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']
if not any(os.getenv(k) for k in AI_KEYS):
    print("❌  Missing AI API Key. Add ANTHROPIC_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY to your .env")
    sys.exit(1)

app = FastAPI(title="Mimo Backend", version="0.1.1")

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # extension can call from any origin
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ── Routes ─────────────────────────────────────────────
# Note: These will throw an import error until we create the files in the next steps!
from routers import auth, ask

app.include_router(auth.router, prefix="/auth", tags=["Auth"])
app.include_router(ask.router, prefix="/ask", tags=["Ask"])
app.include_router(mail.router)
app.include_router(voice.router)

# Health check — useful to verify deploy is alive and for cron jobs
@app.get("/health")
async def health_check():
    return {"ok": True, "service": "mimo-backend", "version": "0.1.1"}

# ── Global error handler ───────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    print(f"Unhandled error: {str(exc)}")
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error"},
    )

# ── Start Server ───────────────────────────────────────
if __name__ == "__main__":
    port = int(os.getenv("PORT", 3000))
    print(f"\n✅  Mimo backend running on port {port}")
    print(f"    Health: /health\n")
    
    # host="0.0.0.0" ensures Render can properly route traffic
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)