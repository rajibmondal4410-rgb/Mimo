from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import List, Optional

from dependencies.auth import auth_middleware
from services.agent import determine_intent_and_ask, execute_agent_search
from services.database import get_user_sheets

router = APIRouter()

class Message(BaseModel):
    role: str
    content: str

class AskRequest(BaseModel):
    question: str
    history: List[Message] = []
    timezone: str = "Asia/Kolkata"

@router.post("/")
async def ask_mimo(
    request_data: AskRequest,
    user: dict = Depends(auth_middleware)
):
    question            = request_data.question.strip()
    history             = request_data.history
    timezone            = request_data.timezone
    google_access_token = user.get("googleAccessToken")

    if not question:
        raise HTTPException(status_code=400, detail="Question is required")
    if not google_access_token:
        raise HTTPException(status_code=400, detail="Google account not connected.")

    try:
        history_dicts = [{"role": msg.role, "content": msg.content} for msg in history]

        saved_sheets   = await get_user_sheets(user["id"])
        sheets_context = ""
        if saved_sheets:
            sheets_list    = "\n".join(
                f'- "{s["name"]}": spreadsheet ID = {s["spreadsheet_id"]}'
                for s in saved_sheets
            )
            sheets_context = f"\n\nUSER'S SAVED SPREADSHEETS (use these IDs directly):\n{sheets_list}"

        intent_data = await determine_intent_and_ask(
            question, history_dicts, timezone, sheets_context
        )

        if intent_data.get("intent") == "ANSWER":
            return {"answer": intent_data.get("answer"), "source": "General"}

        if intent_data.get("intent") == "SEARCH":
            final_result = await execute_agent_search(
                intent_data, google_access_token, timezone, user["id"]
            )
            return {"answer": final_result.get("answer"), "source": final_result.get("source")}

        return {"answer": "I processed the request but encountered an unknown intent.", "source": "System"}

    except Exception as err:
        err_msg = str(err)
        print(f"Ask route error: {err_msg}")
        if "401" in err_msg or "expired" in err_msg.lower():
            raise HTTPException(status_code=401, detail="Access token expired. Please reconnect Google.")
        raise HTTPException(status_code=500, detail="Something went wrong processing that request.")