import asyncio
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build


async def get_upcoming_events(access_token: str, max_results: int = 10) -> List[Dict[str, Any]]:
    """Fetches upcoming events from the user's primary calendar."""
    creds = Credentials(token=access_token)

    def fetch_sync() -> List[Dict[str, Any]]:
        service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        now = datetime.now(timezone.utc).isoformat()

        events_result = service.events().list(
            calendarId="primary",
            timeMin=now,
            maxResults=max_results,
            singleEvents=True,
            orderBy="startTime"
        ).execute()

        events = events_result.get("items", [])
        parsed_events = []

        for e in events:
            start = e.get("start", {}).get("dateTime") or e.get("start", {}).get("date") or ""
            end   = e.get("end",   {}).get("dateTime") or e.get("end",   {}).get("date") or ""
            attendees = [a.get("email") for a in e.get("attendees", []) if a.get("email")]

            parsed_events.append({
                "id":          e.get("id"),
                "title":       e.get("summary", "(No title)"),
                "start":       start,
                "end":         end,
                "location":    e.get("location", ""),
                "attendees":   attendees,
                "description": e.get("description", ""),
            })

        return parsed_events

    return await asyncio.to_thread(fetch_sync)


def make_aware(datetime_str: str, tz_name: str) -> str:
    """
    Takes a naive datetime string like "2026-06-27T17:00:00" and converts it
    to a fully timezone-aware ISO string using the user's actual IANA timezone.
    
    If the string already has timezone info (Z, +, or offset), returns as-is.
    Works for ANY timezone on Earth — no hardcoded offset map needed.
    """
    if not datetime_str:
        return datetime_str

    # Already timezone-aware — leave it alone
    if datetime_str.endswith("Z") or "+" in datetime_str:
        return datetime_str
    if len(datetime_str) > 10 and "-" in datetime_str[10:]:
        return datetime_str

    # Parse the naive datetime string
    try:
        naive_dt = datetime.strptime(datetime_str[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        # If parsing fails, return as-is and let Google API handle it
        return datetime_str

    # Attach the user's real timezone using zoneinfo
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, Exception):
        # Unknown timezone — fall back to UTC rather than crashing
        tz = ZoneInfo("UTC")

    aware_dt = naive_dt.replace(tzinfo=tz)
    return aware_dt.isoformat()


async def create_calendar_event(
    access_token: str,
    title: str,
    start_time: str,
    end_time: Optional[str] = None,
    description: str = "",
    timezone_name: str = "Asia/Kolkata",
) -> Dict[str, Any]:
    """
    Creates a new event on the primary calendar in the user's local timezone.
    timezone_name is the IANA name sent by the frontend (e.g. "America/New_York").
    Defaults to a 1-hour duration when no end_time is given.
    """
    creds = Credentials(token=access_token)

    start_aware = make_aware(start_time, timezone_name)

    if end_time:
        end_aware = make_aware(end_time, timezone_name)
    else:
        try:
            start_dt = datetime.fromisoformat(start_aware)
        except ValueError:
            start_dt = datetime.now(ZoneInfo(timezone_name))
        end_aware = (start_dt + timedelta(hours=1)).isoformat()

    def insert_sync() -> Dict[str, Any]:
        service = build("calendar", "v3", credentials=creds, cache_discovery=False)

        event_body = {
            "summary":     title,
            "description": description,
            "start": {"dateTime": start_aware, "timeZone": timezone_name},
            "end":   {"dateTime": end_aware,   "timeZone": timezone_name},
        }

        res = service.events().insert(
            calendarId="primary",
            body=event_body
        ).execute()

        return {
            "id":    res.get("id"),
            "title": res.get("summary"),
            "start": res.get("start", {}).get("dateTime"),
            "end":   res.get("end",   {}).get("dateTime"),
            "link":  res.get("htmlLink"),
        }

    return await asyncio.to_thread(insert_sync)


def format_events_for_context(events: List[Dict[str, Any]]) -> str:
    """Formats calendar events into a clean text block for the LLM."""
    if not events:
        return "No upcoming events found."

    formatted_list = []
    for i, e in enumerate(events):
        attendees_str = ", ".join(e["attendees"]) if e["attendees"] else "N/A"

        event_block = (
            f"Event {i + 1}:\n"
            f"  Title:     {e['title']}\n"
            f"  Start:     {e['start']}\n"
            f"  End:       {e['end']}\n"
            f"  Location:  {e.get('location') or 'N/A'}\n"
            f"  Attendees: {attendees_str}\n"
            f"  Notes:     {e.get('description') or 'N/A'}"
        )
        formatted_list.append(event_block)

    return "\n\n".join(formatted_list)