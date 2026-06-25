from fastapi import APIRouter, Depends
from services.auth import get_current_user
from services.mail_composer import create_draft, send_draft

router = APIRouter()

@router.post("/mail/draft")
async def create_new_draft(to: str, subject: str, body: str, user=Depends(get_current_user)):
    draft_id = await create_draft(user["token"], to, subject, body)
    return {"status": "draft_created", "draft_id": draft_id}

@router.post("/mail/send/{draft_id}")
async def send_existing_draft(draft_id: str, user=Depends(get_current_user)):
    msg_id = await send_draft(user["token"], draft_id)
    return {"status": "sent", "message_id": msg_id}