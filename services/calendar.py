import asyncio
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Optional
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
            end   = e.get("end", {}).get("dateTime") or e.get("end", {}).get("date") or ""
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


def to_local(datetime_str: str, tz_offset: str = "+05:30") -> str:
    """
    Converts a naive datetime string like "2026-06-18T14:00:00"
    into a timezone-aware ISO string by appending the offset.
    If the string already has a timezone marker, it is returned as-is.
    """
    if not datetime_str:
        return datetime_str
    # Already has timezone info
    if datetime_str.endswith("Z") or "+" in datetime_str:
        return datetime_str
    # Check for negative UTC offset in the time portion (after position 10)
    if "-" in datetime_str[10:]:
        return datetime_str
    return f"{datetime_str}{tz_offset}"


async def create_calendar_event(
    access_token: str,
    title: str,
    start_time: str,
    end_time: Optional[str] = None,
    description: str = "",
    timezone_name: str = "Asia/Kolkata",
) -> Dict[str, Any]:
    """
    Creates a new event on the primary calendar.
    Defaults to a 1-hour duration when no end_time is given.
    Accepts an optional timezone_name (IANA name) — defaults to Asia/Kolkata.

    The agent.py calls this as:
        create_calendar_event(token, title, startTime, endTime, description, timezone)
    so the 6th positional arg maps to timezone_name here — fixing the
    "takes 3 to 5 positional arguments but 6 were given" error.
    """
    creds = Credentials(token=access_token)

    # Map IANA timezone name to a UTC offset string for the naive datetime conversion.
    # We keep this simple: only IST is used in practice; extend the map if needed.
    TZ_OFFSETS = {
        "Asia/Kolkata":    "+05:30",
        "Asia/Calcutta":   "+05:30",
        "UTC":             "+00:00",
        "America/New_York": "-05:00",
        "America/Chicago":  "-06:00",
        "America/Los_Angeles": "-08:00",
        "Europe/London":   "+00:00",
        "Europe/Berlin":   "+01:00",
    }
    tz_offset = TZ_OFFSETS.get(timezone_name, "+05:30")

    start_aware = to_local(start_time, tz_offset)

    if end_time:
        end_aware = to_local(end_time, tz_offset)
    else:
        # Default: 1 hour after start
        try:
            start_dt = datetime.fromisoformat(start_aware)
        except ValueError:
            # Fallback parse for edge cases
            base_dt  = datetime.strptime(start_aware[:19], "%Y-%m-%dT%H:%M:%S")
            h, m     = map(int, tz_offset.lstrip("+-").split(":"))
            sign     = 1 if "+" in tz_offset else -1
            ist_tz   = timezone(timedelta(hours=sign * h, minutes=sign * m))
            start_dt = base_dt.replace(tzinfo=ist_tz)

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
        location_str  = e["location"] or "N/A"

        event_block = (
            f"Event {i + 1}:\n"
            f"  Title:     {e['title']}\n"
            f"  Start:     {e['start']}\n"
            f"  End:       {e['end']}\n"
            f"  Location:  {location_str}\n"
            f"  Attendees: {attendees_str}\n"
            f"  Notes:     {e.get('description') or 'N/A'}"
        )
        formatted_list.append(event_block)

    return "\n\n".join(formatted_list)