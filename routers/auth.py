import os
import urllib.parse
import jwt
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Request, HTTPException, status
from fastapi.responses import RedirectResponse, HTMLResponse
import httpx  # Modern Python alternative to fetch/axios for API requests

from services.database import upsert_user

router = APIRouter()

SCOPES = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/tasks',
]

@router.get("/google")
async def google_login():
    """Generates the Google OAuth consent URL and redirects the user."""
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI")
    
    scope_string = " ".join(SCOPES)
    
    # Constructing the exact URL Google expects for offline access + refresh tokens
    auth_url = (
        f"https://accounts.google.com/o/oauth2/v2/auth"
        f"?client_id={client_id}"
        f"&redirect_uri={redirect_uri}"
        f"&response_type=code"
        f"&scope={urllib.parse.quote(scope_string)}"
        f"&access_type=offline"
        f"&prompt=consent"
    )
    return RedirectResponse(url=auth_url)


@router.get("/callback")
async def google_callback(code: str = None, error: str = None):
    """Handles the redirect from Google, exchanges the code for tokens, and creates the JWT."""
    if error or not code:
        return RedirectResponse(url="/auth/success?error=true")

    try:
        # 1. Exchange the code for Google Access/Refresh Tokens
        token_data = {
            "code": code,
            "client_id": os.getenv("GOOGLE_CLIENT_ID"),
            "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
            "redirect_uri": os.getenv("GOOGLE_REDIRECT_URI"),
            "grant_type": "authorization_code"
        }

        async with httpx.AsyncClient() as client:
            token_res = await client.post("https://oauth2.googleapis.com/token", data=token_data)
            token_res.raise_for_status()
            tokens = token_res.json()

            # 2. Get the User's profile information using the new access token
            userinfo_res = await client.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {tokens.get('access_token')}"}
            )
            userinfo_res.raise_for_status()
            google_user = userinfo_res.json()

        # Calculate exact expiry timestamp in ms
        expires_in_seconds = tokens.get("expires_in", 3599)
        expiry_ms = int((datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)).timestamp() * 1000)

        # 3. Save / update this user in Supabase
        user_payload = {
            "email": google_user.get("email"),
            "name": google_user.get("name"),
            "picture": google_user.get("picture"),
            "accessToken": tokens.get("access_token"),
            "refreshToken": tokens.get("refresh_token"), # Will be None on subsequent logins
            "expiry": expiry_ms
        }
        
        saved_user = await upsert_user(user_payload)

        # 4. Generate the long-lived Mimo JWT 
        jwt_payload = {
            "userId": saved_user.get("id"),
            "email": saved_user.get("email"),
            "exp": datetime.now(timezone.utc) + timedelta(days=90) # 90 day expiry
        }
        
        mimo_token = jwt.encode(jwt_payload, os.getenv("JWT_SECRET"), algorithm="HS256")
        safe_name = urllib.parse.quote(saved_user.get("name", "User"))

        return RedirectResponse(url=f"http://localhost:3000/auth/success?token={mimo_token}&name={safe_name}")

    except Exception as e:
        print(f"Auth callback error: {str(e)}")
        return RedirectResponse(url="/auth/success?error=true")


@router.get("/success")
async def auth_success(error: str = None, name: str = "User"):
    """Displays the final visual confirmation page."""
    if error:
        return HTMLResponse(content='<h2 style="font-family:sans-serif; text-align:center;">Login failed.</h2>')

    html_content = f"""
    <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
      <h2 style="color:#2d2560;">✅ Mimo connected!</h2>
      <p style="color:#8a8070;">Welcome, {name}. Saving your secure token...</p>
    </div>
    """
    return HTMLResponse(content=html_content)