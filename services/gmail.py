import base64
import asyncio
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from zoneinfo import ZoneInfo
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


def build_date_query(date_filter: Optional[str], tz_name: str = "Asia/Kolkata") -> str:
    """
    Builds the Gmail `after:`/`before:` clause IN THE USER'S LOCAL TIMEZONE.
    Gmail's after:/before: are date-granular (YYYY/MM/DD) and are evaluated
    against the message internal date in UTC, so to get "today" right for
    an Asia/Kolkata user we must compute today's date using their tz, not UTC.

    Supported date_filter values:
      "today"      -> after: today 00:00 local, before: tomorrow 00:00 local
      "yesterday"  -> after: yesterday 00:00 local, before: today 00:00 local
      None         -> no date restriction at all
    """
    if not date_filter:
        return ""

    tz = ZoneInfo(tz_name)
    now_local = datetime.now(tz)
    today_local = now_local.date()

    if date_filter == "today":
        start = today_local
        end = today_local + timedelta(days=1)
    elif date_filter == "yesterday":
        start = today_local - timedelta(days=1)
        end = today_local
    else:
        # Unknown filter value — fail safe to no restriction rather than
        # silently fetching the wrong window.
        return ""

    return f" after:{start.strftime('%Y/%m/%d')} before:{end.strftime('%Y/%m/%d')}"


async def get_recent_emails(
    access_token: str,
    max_results: int = 10,
    date_filter: Optional[str] = None,   # "today", "yesterday", or None for latest N
    tz_name: str = "Asia/Kolkata",
    sender: Optional[str] = None,        # name or email to filter by, e.g. "boss@company.com" or "Rohan"
    exclude_bulk: bool = False           # if True, drops promotions/social/updates/forums categories
) -> List[Dict[str, Any]]:
    """
    Fetches emails with optional date + sender filtering, deterministically.

    Default behavior (exclude_bulk=False) fetches the FULL inbox — newsletters,
    automated senders, everything — the same way a human assistant would see
    the inbox before deciding what's relevant. Category exclusion is now an
    explicit opt-in, not a silent default, because hiding "AI Automation"-style
    senders by default was causing real, newer emails to be skipped entirely.

    IMPORTANT: max_results is a HARD CAP. Gmail's list API will not return
    more than this many message IDs, so the LLM downstream can never expand
    or invent extra emails beyond what's actually here — it can only
    summarize what's in this exact list.
    """
    creds = Credentials(token=access_token)

    def fetch_sync() -> List[Dict[str, Any]]:
        service = build("gmail", "v1", credentials=creds, cache_discovery=False)

        base_q = "in:inbox"
        if exclude_bulk:
            base_q += " -category:promotions -category:social -category:updates -category:forums"
        if sender:
            # Gmail's from: operator matches name or email substrings, so
            # "boss" or "boss@company.com" or "Rohan Sharma" all work.
            safe_sender = sender.replace('"', '')
            base_q += f' from:"{safe_sender}"'

        query = base_q + build_date_query(date_filter, tz_name)

        list_res = service.users().messages().list(
            userId="me",
            maxResults=max_results,
            q=query,
            labelIds=["INBOX"]
        ).execute()

        messages = list_res.get("messages", [])
        parsed_results = []

        for msg_meta in messages:
            try:
                msg = service.users().messages().get(
                    userId="me", id=msg_meta["id"], format="full"
                ).execute()

                headers = {
                    h["name"].lower(): h["value"]
                    for h in msg.get("payload", {}).get("headers", [])
                }

                body_text = extract_email_body(msg.get("payload", {}))
                attachments = extract_attachments(msg.get("payload", {}))

                parsed_results.append({
                    "id": msg["id"],
                    "from": headers.get("from", ""),
                    "to": headers.get("to", ""),
                    "subject": headers.get("subject", "No subject"),
                    "date": headers.get("date", ""),
                    "snippet": msg.get("snippet", ""),
                    "isRead": "UNREAD" not in msg.get("labelIds", []),
                    "body": body_text,
                    "attachments": attachments,
                })
            except Exception as e:
                print(f"Skipped email {msg_meta['id']}: {e}")
                continue

        return parsed_results

    return await asyncio.to_thread(fetch_sync)


def format_emails_for_context(emails: List[Dict[str, Any]]) -> str:
    """
    Formats emails into a clean, numbered block for the LLM.
    The exact count is stated up front so the model cannot pad or shrink it.
    """
    if not emails:
        return "RESULT: 0 emails found matching the filter. Tell the user no emails were found — do not invent any."

    blocks = [f"RESULT: Exactly {len(emails)} email(s) found. List ALL of them, do not add or omit any.\n"]
    for i, e in enumerate(emails, 1):
        body_preview = (e.get("body") or e.get("snippet") or "")[:600]
        read_status = "Read" if e.get("isRead") else "UNREAD"
        att_list = ", ".join(a["filename"] for a in e.get("attachments", [])) or "None"

        blocks.append(
            f"--- Email {i} of {len(emails)} ---\n"
            f"From:        {e['from']}\n"
            f"Subject:     {e['subject']}\n"
            f"Date:        {e['date']}\n"
            f"Status:      {read_status}\n"
            f"Attachments: {att_list}\n"
            f"Content:\n{body_preview}"
        )

    return "\n\n".join(blocks)