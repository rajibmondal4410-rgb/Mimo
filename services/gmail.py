import base64
import asyncio
from typing import List, Dict, Any
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

def extract_email_body(payload: Dict[str, Any]) -> str:
    """Recursively traverses the email payload parts to extract plain text."""
    body = ""
    if not payload:
        return body
        
    if "parts" in payload:
        for part in payload["parts"]:
            if part.get("mimeType") == "text/plain":
                data = part.get("body", {}).get("data", "")
                if data:
                    data += "=" * ((4 - len(data) % 4) % 4)
                    body += base64.urlsafe_b64decode(data).decode("utf-8")
            elif "parts" in part:
                body += extract_email_body(part)
    elif payload.get("body", {}).get("data"):
        data = payload["body"]["data"]
        data += "=" * ((4 - len(data) % 4) % 4)
        body = base64.urlsafe_b64decode(data).decode("utf-8")
        
    return body.strip()

async def get_recent_emails(access_token: str, max_results: int = 15) -> List[Dict[str, Any]]:
    """
    Fetches the latest emails sequentially to prevent Google API thread collisions.
    """
    creds = Credentials(token=access_token)

    def fetch_sync() -> List[Dict[str, Any]]:
        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        
        # 1. Fetch the list of Message IDs
        list_res = service.users().messages().list(
            userId="me",
            maxResults=max_results,
            q="in:inbox -category:promotions -category:social -category:updates -category:forums",
            labelIds=["INBOX"]
        ).execute()
        
        messages = list_res.get("messages", [])
        if not messages:
            return []

        parsed_results = []
        
        # 2. Fetch full messages sequentially (Thread-safe)
        for msg_meta in messages:
            try:
                msg = service.users().messages().get(
                    userId="me", id=msg_meta["id"], format="full"
                ).execute()
                
                headers = msg.get("payload", {}).get("headers", [])
                
                def get_header(name: str) -> str:
                    for h in headers:
                        if h.get("name", "").lower() == name.lower():
                            return h.get("value", "")
                    return ""

                full_text = extract_email_body(msg.get("payload", {}))
                
                parsed_results.append({
                    "id": msg["id"],
                    "from": get_header("From"),
                    "subject": get_header("Subject"),
                    "date": get_header("Date"),
                    "snippet": msg.get("snippet", ""),
                    "isRead": "UNREAD" not in msg.get("labelIds", []),
                    "body": full_text,
                })
            except Exception as e:
                print(f"Skipped email {msg_meta['id']} due to error: {e}")
                continue
                
        return parsed_results

    return await asyncio.to_thread(fetch_sync)

def format_emails_for_context(emails: List[Dict[str, Any]]) -> str:
    """Formats emails into a clean, readable text block for the LLM."""
    if not emails:
        return "No emails found in inbox."

    formatted_list = []
    for i, e in enumerate(emails):
        content = e.get("body") or e.get("snippet") or ""
        content = content[:500]
        
        read_status = "Yes" if e.get("isRead") else "No (unread)"
        
        email_block = (
            f"Email {i + 1}:\n"
            f"From:    {e.get('from')}\n"
            f"Subject: {e.get('subject')}\n"
            f"Date:    {e.get('date')}\n"
            f"Read:    {read_status}\n"
            f"Content: {content}"
        )
        formatted_list.append(email_block)

    return "\n\n".join(formatted_list)