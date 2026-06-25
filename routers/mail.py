from fastapi import APIRouter, Depends
from dependencies.auth import auth_middleware
from services.mail_composer import create_draft, send_draft

router = APIRouter()

@router.post("/mail/draft")
async def create_new_draft(to: str, subject: str, body: str, user: dict = Depends(auth_middleware)):
    draft_id = await create_draft(user["googleAccessToken"], to, subject, body)
    return {"status": "draft_created", "draft_id": draft_id}

@router.post("/mail/send/{draft_id}")
async def send_existing_draft(draft_id: str, user: dict = Depends(auth_middleware)):
    msg_id = await send_draft(user["googleAccessToken"], draft_id)
    return {"status": "sent", "message_id": msg_id}