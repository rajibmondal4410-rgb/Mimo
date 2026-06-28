# backend/routers/voice.py
import os
import httpx
from fastapi import APIRouter, UploadFile, File, Depends
from dependencies.auth import auth_middleware

router = APIRouter()

@router.post("/voice/transcribe")
async def transcribe_audio(
    audio: UploadFile = File(...),
    user: dict = Depends(auth_middleware)
):
    """Sends audio to Groq Whisper for transcription."""
    groq_key = os.getenv("GROQ_API_KEY")
    
    audio_bytes = await audio.read()
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {groq_key}"},
            files={"file": (audio.filename, audio_bytes, audio.content_type)},
            data={"model": "whisper-large-v3-turbo", "language": "en"}
        )
        
        if res.status_code != 200:
            return {"error": "Transcription failed", "detail": res.text}
            
        return {"transcript": res.json().get("text", "")}