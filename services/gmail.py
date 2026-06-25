import base64
import asyncio
from datetime import datetime, timezone
from typing import List, Dict, Any
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build


def extract_email_body(payload: Dict[str, Any]) -> str:
    """Recursively extracts plain text from email payload."""
    body = ""
    if not payload:
        return body
    if "parts" in payload:
        for part in payload["parts"]:
            mime = part.get("mimeType", "")
            if mime == "text/plain":
                data = part.get("body", {}).get("data", "")
                if data:
                    data += "=" * ((4 - len(data) % 4) % 4)
                    try:
                        body += base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
                    except Exception:
                        pass
            elif mime.startswith("multipart/"):
                body += extract_email_body(part)
    elif payload.get("body", {}).get("data"):
        data = payload["body"]["data"]
        data += "=" * ((4 - len(data) % 4) % 4)
        try:
            body = base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
        except Exception:
            pass
    return body.strip()


def extract_attachments(payload: Dict[str, Any]) -> List[Dict[str, str]]:
    """Lists attachments (name + mimeType) from the email."""
    attachments = []
    if not payload:
        return attachments
    parts = payload.get("parts", [])
    for part in parts:
        filename = part.get("filename", "")
        if filename:
            attachments.append({
                "filename": filename,
                "mimeType": part.get("mimeType", "unknown"),
                "attachmentId": part.get("body", {}).get("attachmentId", "")
            })
        if part.get("parts"):
            attachments.extend(extract_attachments(part))
    return attachments


async def get_recent_emails(access_token: str, max_results: int = 10, date_filter: str = None) -> List[Dict[str, Any]]:
    creds = Credentials(token=access_token)
    def fetch_sync() -> List[Dict[str, Any]]:
        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        
        # Build strict query
        q = "in:inbox -category:promotions -category:social -category:updates -category:forums"
        if date_filter == "today":
            today = datetime.now(timezone.utc).strftime("%Y/%m/%d")
            q += f" after:{today}"
            
        results = service.users().messages().list(userId="me", maxResults=max_results, q=q).execute()
        messages = results.get("messages", [])
        
        parsed = []
        for m in messages:
            msg = service.users().messages().get(userId="me", id=m["id"], format="full").execute()
            headers = {h['name'].lower(): h['value'] for h in msg.get("payload", {}).get("headers", [])}
            parsed.append({
                "from": headers.get("from", "Unknown"),
                "subject": headers.get("subject", "No Subject"),
                "body": (extract_email_body(msg.get("payload", {})) or msg.get("snippet", ""))[:500],
                "date": headers.get("date", "")
            })
        return parsed
    return await asyncio.to_thread(fetch_sync)

def format_emails_for_context(emails: List[Dict[str, Any]]) -> str:
    """Formats emails into a clean block for the LLM."""
    if not emails:
        return "No emails found."

    blocks = []
    for i, e in enumerate(emails, 1):
        body_preview = (e.get("body") or e.get("snippet") or "")[:600]
        read_status = "Read" if e.get("isRead") else "UNREAD"
        att_list = ", ".join(a["filename"] for a in e.get("attachments", [])) or "None"

        blocks.append(
            f"--- Email {i} ---\n"
            f"From:        {e['from']}\n"
            f"Subject:     {e['subject']}\n"
            f"Date:        {e['date']}\n"
            f"Status:      {read_status}\n"
            f"Attachments: {att_list}\n"
            f"Content:\n{body_preview}"
        )

    return "\n\n".join(blocks)