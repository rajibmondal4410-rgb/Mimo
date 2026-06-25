import base64
from email.message import EmailMessage
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import asyncio

async def create_draft(access_token: str, to: str, subject: str, body: str) -> str:
    """Constructs a MIME email and saves it as a Gmail draft."""
    creds = Credentials(token=access_token)
    
    def sync_create():
        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        message = EmailMessage()
        message.set_content(body)
        message["to"] = to
        message["subject"] = subject
        
        # MIME encoding required by Gmail API
        raw_msg = {"message": {"raw": base64.urlsafe_b64encode(message.as_bytes()).decode()}}
        draft = service.users().drafts().create(userId="me", body=raw_msg).execute()
        return draft["id"]

    return await asyncio.to_thread(sync_create)

async def send_draft(access_token: str, draft_id: str) -> str:
    """Promotes a draft to a sent message."""
    creds = Credentials(token=access_token)
    
    def sync_send():
        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        sent = service.users().drafts().send(userId="me", body={"id": draft_id}).execute()
        return sent["id"]

    return await asyncio.to_thread(sync_send)