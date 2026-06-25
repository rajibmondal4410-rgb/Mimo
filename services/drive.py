import asyncio
import concurrent.futures
from typing import List, Dict, Any
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

async def list_all_drive_files(access_token: str, max_results: int = 50) -> List[Dict[str, Any]]:
    """
    Lists ALL files in Google Drive with pagination support.
    Used when user asks "what files do I have" or "list my drive".
    """
    creds = Credentials(token=access_token)

    def fetch_sync() -> List[Dict[str, Any]]:
        service = build("drive", "v3", credentials=creds, cache_discovery=False)
        
        res = service.files().list(
            q="trashed = false and 'me' in owners",
            pageSize=max_results,
            fields="files(id, name, mimeType, modifiedTime, webViewLink)",
            orderBy="modifiedTime desc"
        ).execute()
        
        files = res.get("files", [])
        
        return [{
            "id": f.get("id"),
            "name": f.get("name"),
            "mimeType": f.get("mimeType"),
            "modifiedTime": f.get("modifiedTime"),
            "link": f.get("webViewLink")
        } for f in files]

    return await asyncio.to_thread(fetch_sync)


async def search_drive_files(access_token: str, query: str, max_results: int = 20) -> List[Dict[str, Any]]:
    """
    Searches Google Drive using THREE strategies in parallel:
    1. Exact file name match
    2. Partial name contains
    3. Full text content search
    """
    creds = Credentials(token=access_token)
    safe_query = query.replace("'", "\\'")

    def search_sync() -> List[Dict[str, Any]]:
        service = build("drive", "v3", credentials=creds, cache_discovery=False)
        
        # Define our three parallel search queries
        queries = [
            f"name = '{safe_query}' and trashed = false",
            f"name contains '{safe_query}' and trashed = false",
            f"fullText contains '{safe_query}' and trashed = false"
        ]

        def run_query(q_str: str) -> List[Dict[str, Any]]:
            try:
                res = service.files().list(
                    q=q_str,
                    pageSize=max_results,
                    fields="files(id, name, mimeType, modifiedTime, webViewLink)",
                    orderBy="modifiedTime desc"
                ).execute()
                return res.get("files", [])
            except Exception as e:
                print(f"Drive search query failed: {str(e)}")
                return []

        # Execute all three queries concurrently
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            results = list(executor.map(run_query, queries))

        # Merge results and remove duplicates using a Set
        seen = set()
        merged = []
        for result_list in results:
            for f in result_list:
                if f["id"] not in seen:
                    seen.add(f["id"])
                    merged.append(f)

        # Slice to the requested max_results and format
        return [{
            "id": f.get("id"),
            "name": f.get("name"),
            "mimeType": f.get("mimeType"),
            "modifiedTime": f.get("modifiedTime"),
            "link": f.get("webViewLink")
        } for f in merged[:max_results]]

    return await asyncio.to_thread(search_sync)


async def read_google_doc(access_token: str, file_id: str) -> str:
    """
    Reads the plain text content of a Google Doc by file ID.
    Only works for native Google Docs (mimeType: application/vnd.google-apps.document).
    """
    creds = Credentials(token=access_token)

    def read_sync() -> str:
        service = build("drive", "v3", credentials=creds, cache_discovery=False)
        
        # First verify the file is a Google Doc, not a PDF or video
        meta = service.files().get(
            fileId=file_id,
            fields="id, name, mimeType"
        ).execute()
        
        mime_type = meta.get("mimeType")
        if mime_type != "application/vnd.google-apps.document":
            return f"[This file is a {mime_type} — Mimo can only read Google Docs as text. PDFs and other formats are not supported yet.]"

        # Export the document as plain text
        res = service.files().export(
            fileId=file_id, 
            mimeType="text/plain"
        ).execute()
        
        # The Python Google API client returns bytes for exports
        if isinstance(res, bytes):
            return res.decode("utf-8")
        return str(res)

    return await asyncio.to_thread(read_sync)


def format_files_for_context(files: List[Dict[str, Any]]) -> str:
    """
    Formats file list. Always includes the file ID so the AI
    can pass it directly to read_google_doc without searching again.
    """
    if not files:
        return "No matching files found in Drive."

    formatted_list = []
    for i, f in enumerate(files):
        file_block = (
            f"File {i + 1}:\n"
            f"  Name:     {f.get('name')}\n"
            f"  ID:       {f.get('id')}\n"
            f"  Type:     {f.get('mimeType')}\n"
            f"  Modified: {f.get('modifiedTime')}\n"
            f"  Link:     {f.get('link')}"
        )
        formatted_list.append(file_block)

    return "\n\n".join(formatted_list)