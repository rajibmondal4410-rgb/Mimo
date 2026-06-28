import base64
import re
from email.message import EmailMessage
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import asyncio

def extract_email_from_to(to: str) -> str:
    """
    Extracts a valid email from the to field.
    Handles: "Guddu <guddu@gmail.com>", "guddu@gmail.com", "Guddu"
    If no email found, returns the original string and lets Gmail error naturally.
    """
    # Already a valid email
    if re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', to.strip()):
        return to.strip()
    
    # Format: "Name <email@domain.com>"
    match = re.search(r'<([^@\s]+@[^@\s]+\.[^@\s]+)>', to)
    if match:
        return match.group(1)
    
    # Just a name with no email — return as-is, Gmail will reject it
    # but at least we tried
    return to.strip()


async def create_draft(access_token: str, to: str, subject: str, body: str) -> str:
    """Constructs a MIME email and saves it as a Gmail draft."""
    creds = Credentials(token=access_token)
    
    # Clean the to field
    clean_to = extract_email_from_to(to)
    
    def sync_create():
        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        message = EmailMessage()
        message.set_content(body)
        message["to"]      = clean_to
        message["subject"] = subject
        
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