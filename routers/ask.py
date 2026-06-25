from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

from dependencies.auth import auth_middleware
# These imports will be resolved when we build services/agent.py
from services.agent import determine_intent_and_ask, execute_agent_search

router = APIRouter()

# ── 1. Define the exact shape of incoming data ─────────
class Message(BaseModel):
    role: str
    content: str

class AskRequest(BaseModel):
    question: str
    history: List[Message] = []
    timezone: str = "Asia/Kolkata"

# ── 2. The Route Handler ───────────────────────────────
@router.post("/")
async def ask_mimo(
    request_data: AskRequest, 
    user: dict = Depends(auth_middleware)  # This triggers auth.py automatically!
):
    question = request_data.question.strip()
    history = request_data.history
    timezone = request_data.timezone
    
    google_access_token = user.get("googleAccessToken")

    if not question:
        raise HTTPException(status_code=400, detail="Question is required")

    if not google_access_token:
        raise HTTPException(status_code=400, detail="Google account not connected.")

    try:
        # Convert Pydantic models back to standard dictionaries for the AI engine
        history_dicts = [{"role": msg.role, "content": msg.content} for msg in history]
        
        # Step 1: Figure out if this is a general chat or a tool search
        intent_data = await determine_intent_and_ask(question, history_dicts, timezone)

        if intent_data.get("intent") == "ANSWER":
            return {"answer": intent_data.get("answer"), "source": "General"}

        if intent_data.get("intent") == "SEARCH":
            # Step 2: Execute the Google Workspace tools
            final_result = await execute_agent_search(intent_data, google_access_token, timezone)
            return {"answer": final_result.get("answer"), "source": final_result.get("source")}

        # Fallback if intent is somehow missing
        return {"answer": "I processed the request but encountered an unknown intent.", "source": "System"}

    except Exception as err:
        err_msg = str(err)
        print(f"Ask route error: {err_msg}")
        
        # Check for Google API authentication errors bubbling up from the agent
        if "401" in err_msg or "expired" in err_msg.lower():
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, 
                detail="Access token expired. Please reconnect Google."
            )
        
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail="Something went wrong processing that request."
        )