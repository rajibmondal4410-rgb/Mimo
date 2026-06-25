import os
import time
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request as GoogleRequest
from services.database import get_user_by_id, update_google_access_token

# Automatically extracts the 'Bearer <token>' from the Authorization header
security = HTTPBearer()

async def auth_middleware(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """
    Verifies the Mimo JWT, ensures the user exists, and checks the Google access token.
    If the Google token is expired, it silently refreshes it using the stored refresh_token,
    updates Supabase, and returns the fully authenticated user object.
    """
    token = credentials.credentials
    jwt_secret = os.getenv("JWT_SECRET")

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, 
            detail="No token provided. Please login again."
        )

    # 1. Verify Mimo JWT
    try:
        decoded = jwt.decode(token, jwt_secret, algorithms=["HS256"])
        user_id = decoded.get("userId")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session. Please login again.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token. Please login again.")

    # 2. Fetch user row from Supabase
    user = await get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found. Please login again.")

    google_access_token = user.get("google_access_token")
    google_refresh_token = user.get("google_refresh_token")
    google_token_expiry = user.get("google_token_expiry") # Assumed to be in milliseconds

    # 3. Check if Google access token has expired (with a 1-minute / 60,000ms buffer)
    current_time_ms = int(time.time() * 1000)
    is_expired = not google_token_expiry or current_time_ms >= (google_token_expiry - 60000)

    if is_expired:
        if not google_refresh_token:
            # User revoked access or old account missing refresh token
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, 
                detail="Gmail access expired. Please reconnect Google."
            )

        # 4. Silently refresh the access token via Google API
        try:
            creds = Credentials(
                token=google_access_token,
                refresh_token=google_refresh_token,
                token_uri="https://oauth2.googleapis.com/token",
                client_id=os.getenv("GOOGLE_CLIENT_ID"),
                client_secret=os.getenv("GOOGLE_CLIENT_SECRET")
            )
            
            # Execute the refresh
            creds.refresh(GoogleRequest())
            
            # Extract new values
            google_access_token = creds.token
            google_token_expiry = int(creds.expiry.timestamp() * 1000)

            # 5. Save the fresh token back to Supabase
            await update_google_access_token(user_id, google_access_token, google_token_expiry)
            
        except Exception as e:
            print(f"Auth middleware token refresh error: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, 
                detail="Session error while refreshing Google access. Please login again."
            )

    # 6. Return the clean user data (FastAPI attaches this directly to the route request)
    return {
        "id": user_id,
        "email": user.get("email"),
        "name": user.get("name"),
        "googleAccessToken": google_access_token,
    }