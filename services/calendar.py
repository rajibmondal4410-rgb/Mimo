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
        # Get current time in UTC, formatted exactly how Google expects it
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
            # Handle full-day events (date) vs specific time events (dateTime)
            start = e.get("start", {}).get("dateTime") or e.get("start", {}).get("date") or ""
            end = e.get("end", {}).get("dateTime") or e.get("end", {}).get("date") or ""
            
            # Safely extract attendee emails
            attendees = [a.get("email") for a in e.get("attendees", []) if a.get("email")]
            
            parsed_events.append({
                "id": e.get("id"),
                "title": e.get("summary", "(No title)"),
                "start": start,
                "end": end,
                "location": e.get("location", ""),
                "attendees": attendees,
                "description": e.get("description", "")
            })
            
        return parsed_events

    # Execute Google API synchronously in a background thread
    return await asyncio.to_thread(fetch_sync)


def to_ist(datetime_str: str) -> str:
    """
    Converts a naive datetime string like "2026-06-18T14:00:00"
    into a proper IST-aware ISO string "2026-06-18T14:00:00+05:30"
    so Google Calendar stores it correctly as IST, not UTC.
    """
    # If it already contains a timezone marker (Z, +, or a minus sign in the time portion), leave it
    if datetime_str.endswith("Z") or "+" in datetime_str or ("-" in datetime_str and datetime_str.rfind("-") > 9):
        return datetime_str
    
    # Append the +05:30 offset for India Standard Time
    return f"{datetime_str}+05:30"


async def create_calendar_event(
    access_token: str, 
    title: str, 
    start_time: str, 
    end_time: Optional[str] = None, 
    description: str = ""
) -> Dict[str, Any]:
    """Creates a new event on the primary calendar, defaulting to a 1-hour duration if no end_time is provided."""
    creds = Credentials(token=access_token)
    
    start_ist = to_ist(start_time)
    
    if end_time:
        end_ist = to_ist(end_time)
    else:
        # Default: 1 hour after start
        # Parse the IST string safely using Python's datetime capabilities
        try:
            start_dt = datetime.fromisoformat(start_ist)
        except ValueError:
            # Fallback for older python versions or weird string formats
            base_dt = datetime.strptime(start_ist[:19], "%Y-%m-%dT%H:%M:%S")
            ist_tz = timezone(timedelta(hours=5, minutes=30))
            start_dt = base_dt.replace(tzinfo=ist_tz)
            
        # Add exactly 1 hour
        end_dt = start_dt + timedelta(hours=1)
        end_ist = end_dt.isoformat()

    def insert_sync() -> Dict[str, Any]:
        service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        
        event_body = {
            "summary": title,
            "description": description,
            "start": {"dateTime": start_ist, "timeZone": "Asia/Kolkata"},
            "end": {"dateTime": end_ist, "timeZone": "Asia/Kolkata"},
        }
        
        res = service.events().insert(
            calendarId="primary",
            body=event_body
        ).execute()
        
        return {
            "id": res.get("id"),
            "title": res.get("summary"),
            "start": res.get("start", {}).get("dateTime"),
            "end": res.get("end", {}).get("dateTime"),
            "link": res.get("htmlLink")
        }

    return await asyncio.to_thread(insert_sync)


def format_events_for_context(events: List[Dict[str, Any]]) -> str:
    """Formats events into a clean text block for the LLM."""
    if not events:
        return "No upcoming events found."

    formatted_list = []
    for i, e in enumerate(events):
        attendees_str = ", ".join(e["attendees"]) if e["attendees"] else "N/A"
        location_str = e["location"] or "N/A"
        
        event_block = (
            f"Event {i + 1}:\n"
            f"  Title:     {e['title']}\n"
            f"  Start:     {e['start']}\n"
            f"  End:       {e['end']}\n"
            f"  Location:  {location_str}\n"
            f"  Attendees: {attendees_str}"
        )
        formatted_list.append(event_block)
        
    return "\n\n".join(formatted_list)