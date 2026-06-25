import base64
from typing import List, Dict, Any
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

# We keep this helper outside to keep the logic clean
def extract_email_body(payload: Dict[str, Any]) -> str:
    body = ""
    if not payload: return body
    if "parts" in payload:
        for part in payload["parts"]:
            if part.get("mimeType") == "text/plain":
                data = part.get("body", {}).get("data", "")
                if data:
                    data += "=" * ((4 - len(data) % 4) % 4)
                    body += base64.urlsafe_b64decode(data).decode("utf-8")
    elif payload.get("body", {}).get("data"):
        data = payload["body"]["data"]
        data += "=" * ((4 - len(data) % 4) % 4)
        body = base64.urlsafe_b64decode(data).decode("utf-8")
    return body.strip()

async def get_recent_emails(access_token: str, max_results: int = 10) -> List[Dict[str, Any]]:
    # Reduced max_results to 10 to ensure we don't hit Render/Google timeouts
    creds = Credentials(token=access_token)

    def fetch_sync() -> List[Dict[str, Any]]:
        service = build("gmail", "v1", credentials=creds, cache_discovery=False)
        
        # 1. Fetch fewer messages to keep the request snappy
        list_res = service.users().messages().list(
            userId="me",
            maxResults=max_results,
            q="in:inbox -category:promotions -category:social -category:updates -category:forums",
            labelIds=["INBOX"]
        ).execute()
        
        messages = list_res.get("messages", [])
        parsed_results = []
        
        # 2. Sequential fetch is safer for free-tier cloud instances
        for msg_meta in messages:
            try:
                msg = service.users().messages().get(
                    userId="me", id=msg_meta["id"], format="full"
                ).execute()
                
                headers = {h['name'].lower(): h['value'] for h in msg.get("payload", {}).get("headers", [])}
                
                parsed_results.append({
                    "id": msg["id"],
                    "from": headers.get("from", ""),
                    "subject": headers.get("subject", ""),
                    "date": headers.get("date", ""),
                    "snippet": msg.get("snippet", ""),
                    "isRead": "UNREAD" not in msg.get("labelIds", []),
                    "body": extract_email_body(msg.get("payload", {})),
                })
            except Exception:
                continue
        return parsed_results

    import asyncio
    return await asyncio.to_thread(fetch_sync)

def format_emails_for_context(emails: List[Dict[str, Any]]) -> str:
    if not emails: return "No emails found in inbox."
    return "\n\n".join([f"From: {e['from']}\nSubject: {e['subject']}\nContent: {e['body'][:300]}" for e in emails])