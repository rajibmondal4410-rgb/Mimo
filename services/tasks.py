import asyncio
from typing import List, Dict, Any, Optional
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

async def get_tasks(access_token: str, max_results: int = 20) -> List[Dict[str, Any]]:
    """
    Fetches pending (incomplete) tasks from the user's default Google Tasks list.
    """
    creds = Credentials(token=access_token)

    def fetch_sync() -> List[Dict[str, Any]]:
        service = build("tasks", "v1", credentials=creds, cache_discovery=False)
        
        res = service.tasks().list(
            tasklist="@default",
            maxResults=max_results,
            showCompleted=False
        ).execute()
        
        tasks_list = res.get("items", [])
        
        return [{
            "id": t.get("id"),
            "title": t.get("title"),
            "notes": t.get("notes", ""),
            "due": t.get("due", ""),
            "status": t.get("status")
        } for t in tasks_list]

    return await asyncio.to_thread(fetch_sync)


async def create_task(access_token: str, title: str, notes: str = "") -> Dict[str, Any]:
    """
    Creates a new task in the user's default Google Tasks list.
    This is the "agentic execution" piece — Mimo writing back to Google, not just reading.
    """
    creds = Credentials(token=access_token)

    def insert_sync() -> Dict[str, Any]:
        service = build("tasks", "v1", credentials=creds, cache_discovery=False)
        
        task_body = {
            "title": title,
            "notes": notes
        }
        
        res = service.tasks().insert(
            tasklist="@default",
            body=task_body
        ).execute()
        
        return res

    return await asyncio.to_thread(insert_sync)


def format_tasks_for_context(task_list: List[Dict[str, Any]]) -> str:
    """
    Formats tasks into a clean text block for the LLM.
    """
    if not task_list:
        return "No pending tasks found."

    formatted_list = []
    for i, t in enumerate(task_list):
        task_block = (
            f"Task {i + 1}:\n"
            f"  Title: {t.get('title')}\n"
            f"  Due:   {t.get('due') or 'No due date'}\n"
            f"  Notes: {t.get('notes') or 'N/A'}"
        )
        formatted_list.append(task_block)

    return "\n\n".join(formatted_list)