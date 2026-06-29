import os
from typing import Dict, Any, Optional
from supabase import create_client, Client

# Fetch environment variables
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    print("⚠️ WARNING: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env")

# Initialize the Supabase client using the service_role key
# This gives the backend full bypass access (server-side only)
supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

async def upsert_user(google_user: Dict[str, Any]) -> Dict[str, Any]:
    """
    Creates a new user OR updates an existing one (upsert).
    Called every time someone logs in with Google.
    """
    payload = {
        "email": google_user.get("email"),
        "name": google_user.get("name"),
        "picture": google_user.get("picture"),
        "google_access_token": google_user.get("accessToken"),
        "google_token_expiry": google_user.get("expiry"),
    }

    # Only overwrite refresh_token if a new one was given.
    # Google only sends a refresh_token on the FIRST consent.
    refresh_token = google_user.get("refreshToken")
    if refresh_token:
        payload["google_refresh_token"] = refresh_token

    try:
        # Note: In Python, Supabase executes synchronously by default, 
        # but wrapping it in an async function keeps your FastAPI routes non-blocking.
        response = supabase.table("mimo_users").upsert(
            payload, 
            on_conflict="email"
        ).execute()
        
        # The Python SDK returns a data list. Grab the first (and only) row.
        if response.data and len(response.data) > 0:
            return response.data[0]
        else:
            raise Exception("No data returned from Supabase after upsert.")
            
    except Exception as e:
        raise Exception(f"Supabase upsert failed: {str(e)}")


async def get_user_by_email(email: str) -> Optional[Dict[str, Any]]:
    """Fetches a user by their email address."""
    try:
        response = supabase.table("mimo_users").select("*").eq("email", email).execute()
        
        if response.data and len(response.data) > 0:
            return response.data[0]
        return None
    except Exception as e:
        raise Exception(f"Supabase fetch by email failed: {str(e)}")


async def get_user_by_id(user_id: str) -> Optional[Dict[str, Any]]:
    """Fetches a user by their internal Mimo ID (stored inside the JWT)."""
    try:
        response = supabase.table("mimo_users").select("*").eq("id", user_id).execute()
        
        if response.data and len(response.data) > 0:
            return response.data[0]
        return None
    except Exception as e:
        raise Exception(f"Supabase fetch by ID failed: {str(e)}")


async def update_google_access_token(user_id: str, access_token: str, expiry: int) -> None:
    """
    Updates just the Google access token + expiry after a silent refresh.
    Called automatically by the auth middleware whenever the old token expires.
    """
    try:
        supabase.table("mimo_users").update({
            "google_access_token": access_token,
            "google_token_expiry": expiry
        }).eq("id", user_id).execute()
    except Exception as e:
        raise Exception(f"Supabase token update failed: {str(e)}")
    
async def save_user_sheet(user_id: str, name: str, spreadsheet_id: str) -> Dict[str, Any]:
    """Saves a named spreadsheet reference for the user."""
    try:
        response = supabase.table("user_sheets").upsert(
            {"user_id": user_id, "name": name.lower(), "spreadsheet_id": spreadsheet_id},
            on_conflict="user_id,name"
        ).execute()
        return response.data[0] if response.data else {}
    except Exception as e:
        raise Exception(f"Save sheet failed: {str(e)}")


async def get_user_sheets(user_id: str) -> List[Dict[str, Any]]:
    """Gets all saved spreadsheet references for the user."""
    try:
        response = supabase.table("user_sheets").select("*").eq("user_id", user_id).execute()
        return response.data or []
    except Exception as e:
        raise Exception(f"Get sheets failed: {str(e)}")


async def find_user_sheet(user_id: str, name: str) -> Optional[Dict[str, Any]]:
    """Finds a sheet by fuzzy name match."""
    try:
        response = supabase.table("user_sheets").select("*").eq("user_id", user_id).execute()
        sheets = response.data or []
        name_lower = name.lower()
        for s in sheets:
            if name_lower in s["name"] or s["name"] in name_lower:
                return s
        return None
    except Exception as e:
        return None