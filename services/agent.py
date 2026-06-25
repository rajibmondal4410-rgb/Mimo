import os
import json
import httpx
import asyncio
from typing import List, Dict, Any, Tuple

# ── Import ALL Services (Python equivalents) ──
from services.gmail import get_recent_emails, format_emails_for_context
from services.calendar import get_upcoming_events, create_calendar_event, format_events_for_context
from services.drive import list_all_drive_files, search_drive_files, read_google_doc, format_files_for_context
from services.sheets import read_sheet_range, format_sheet_for_context
from services.tasks import get_tasks, create_task, format_tasks_for_context

# ─────────────────────────────────────────────────────────────────────
# PROVIDER HELPERS
# ─────────────────────────────────────────────────────────────────────

async def call_groq(messages: List[Dict[str, str]], system_prompt: str, tools: List[Dict[str, Any]] = None) -> Dict[str, Any]:
    groq_key = os.getenv("GROQ_API_KEY")
    if not groq_key:
        raise ValueError("No GROQ_API_KEY found in environment variables.")
        
    body = {
        "model": "llama-3.3-70b-versatile",
        "messages": [{"role": "system", "content": system_prompt}] + messages,
        "temperature": 0,
        "parallel_tool_calls": False
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"},
            json=body
        )
        if res.status_code != 200:
            raise RuntimeError(f"Groq API Error: {res.text}")
            
        data = res.json()
        msg = data["choices"][0]["message"]
        
        if msg.get("tool_calls"):
            calls = []
            for tc in msg["tool_calls"]:
                calls.append({
                    "id": tc["id"],
                    "name": tc["function"]["name"],
                    "input": json.loads(tc["function"]["arguments"])
                })
            return {"action": "tool_calls", "calls": calls, "rawMessage": msg}
            
        return {"action": "text", "text": msg.get("content") or ""}


async def call_gemini(messages: List[Dict[str, str]], system_prompt: str, tools: List[Dict[str, Any]] = None) -> Dict[str, Any]:
    gemini_key = os.getenv("GEMINI_API_KEY")
    if not gemini_key:
        raise ValueError("No GEMINI_API_KEY found in environment variables.")
        
    body = {
        "model": "gemini-2.0-flash",
        "messages": [{"role": "system", "content": system_prompt}] + messages,
        "temperature": 0
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            headers={"Authorization": f"Bearer {gemini_key}", "Content-Type": "application/json"},
            json=body
        )
        if res.status_code != 200:
            raise RuntimeError(f"Gemini API Error: {res.text}")
            
        data = res.json()
        msg = data["choices"][0]["message"]
        
        if msg.get("tool_calls"):
            calls = []
            for tc in msg["tool_calls"]:
                calls.append({
                    "id": tc["id"],
                    "name": tc["function"]["name"],
                    "input": json.loads(tc["function"]["arguments"])
                })
            return {"action": "tool_calls", "calls": calls, "rawMessage": msg}
            
        return {"action": "text", "text": msg.get("content") or ""}


async def ask_any(messages: List[Dict[str, str]], system_prompt: str, tools: List[Dict[str, Any]] = None) -> Dict[str, Any]:
    errors = []
    for fn in [call_groq, call_gemini]:
        try:
            return await fn(messages, system_prompt, tools)
        except Exception as e:
            errors.append(str(e))
    raise RuntimeError(f"All providers failed: {' | '.join(errors)}")


async def synthesise(final_messages: List[Dict[str, Any]], system_prompt: str) -> Dict[str, Any]:
    errors = []
    for fn in [call_groq, call_gemini]:
        try:
            return await fn(final_messages, system_prompt, None)
        except Exception as e:
            errors.append(str(e))
    raise RuntimeError(f"Synthesis failed: {' | '.join(errors)}")

# ── AGENT TOOL DEFINITIONS ───────────────────────────────────────────
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_gmail",
            "description": "Check recent emails from inbox only (no promotions).",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_calendar",
            "description": "Check upcoming meetings and schedule.",
            "parameters": {"type": "object", "properties": {"timeframe": {"type": "string"}}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_calendar_event",
            "description": "Create a new event on Google Calendar.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Event title"},
                    "startTime": {"type": "string", "description": "Naive local datetime, NO timezone suffix. e.g. '2026-06-20T14:00:00'"},
                    "endTime": {"type": "string", "description": "Naive local datetime, NO timezone suffix. Optional."},
                    "description": {"type": "string", "description": "Optional notes."}
                },
                "required": ["title", "startTime"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_tasks",
            "description": "Fetch pending to-do items.",
            "parameters": {"type": "object", "properties": {"status": {"type": "string"}}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_task",
            "description": "Create a new task.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "notes": {"type": "string"}
                },
                "required": ["title"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_drive_files",
            "description": "List ALL files in the user's Google Drive. Use when user asks 'what files do I have', 'show my drive', 'list my documents'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "maxResults": {"type": "number", "description": "How many files. Default 50."}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_google_drive",
            "description": "Search Drive for a specific file by name or keyword. Use short keywords only (2-4 words).",
            "parameters": {
                "type": "object",
                "properties": {
                    "searchQuery": {"type": "string", "description": "Short keyword e.g. 'Startup Business' not the full title"}
                },
                "required": ["searchQuery"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_google_doc",
            "description": "Read the full text content of a Google Doc. ALWAYS call search_google_drive first to get the fileId. Never pass a file name — only a real fileId.",
            "parameters": {
                "type": "object",
                "properties": {
                    "fileId": {"type": "string", "description": "The Google Drive file ID from search results e.g. '1Ud5_hRJbaJv8...'"}
                },
                "required": ["fileId"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_google_sheets",
            "description": "Read data from a Google Spreadsheet. When user asks about specific data in a sheet, use a targeted range.",
            "parameters": {
                "type": "object",
                "properties": {
                    "spreadsheetId": {"type": "string", "description": "ONLY the ID between /d/ and /edit in the URL."},
                    "range": {"type": "string", "description": "Cell range. Use A1:Z200 to get more rows. Default A1:Z100."},
                    "sheetName": {"type": "string", "description": "Optional sheet/tab name e.g. 'SAMPLE 1'"}
                },
                "required": ["spreadsheetId"]
            }
        }
    }
]

SYSTEM_PROMPT = """You are Mimo, an elite AI assistant connected to Google Workspace.

RULES:
1. Be direct and concise. No preamble.
2. Never mention which tools or APIs you used.
3. No JSON in responses — plain text only.
4. For lists use clean bullet points.
5. CRITICAL — Gmail: When the user asks "who emailed me today" or "today's emails", use read_gmail. When they ask about a specific email or "what does X email say", use read_gmail and find that email in the results. When they ask "last email" or "last 2 emails", fetch only that count.
6. CRITICAL — Email content: If an email has attachments listed (PDF, invoice, etc.), mention them clearly to the user.
7. CRITICAL — Draft email: When the user says "write a draft" or "send an email to X", respond with the draft content clearly formatted as:
   TO: [recipient]
   SUBJECT: [subject]
   BODY: [body text]
   Then tell the user to click "Approve & Send" to send it.
8. CRITICAL — Google Docs: ALWAYS call search_google_drive FIRST to get the fileId. Then call read_google_doc with that fileId.
9. CRITICAL — Sheets: read full sheet with range A1:Z200 and look carefully at ALL columns.
10. CRITICAL — Calendar: generate startTime as naive local datetime, NO timezone suffix e.g. "2026-06-20T14:00:00".
11. If you cannot find data, say "I couldn't find that" — never make up an answer."""


# ── STEP 1: Intent detection ─────────────────────────────────────────
async def determine_intent_and_ask(question: str, history: List[Dict[str, str]], timezone: str = "Asia/Kolkata") -> Dict[str, Any]:
    messages = history[-4:] + [{"role": "user", "content": question}]
    ai_res = await ask_any(messages, SYSTEM_PROMPT, TOOLS)
    
    if ai_res["action"] == "text":
        return {"intent": "ANSWER", "answer": ai_res["text"]}
        
    return {
        "intent": "SEARCH", 
        "toolCalls": ai_res["calls"], 
        "rawMessage": ai_res["rawMessage"], 
        "messages": messages
    }


# ── STEP 2: Execute tools ────────────────────────────────────────────
async def execute_agent_search(intent_data: Dict[str, Any], google_access_token: str, timezone: str = "Asia/Kolkata") -> Dict[str, Any]:
    tool_calls = intent_data["toolCalls"]
    raw_message = intent_data["rawMessage"]
    messages = intent_data["messages"]
    sources_used = []

    async def run_single_tool(call: Dict[str, Any]) -> Dict[str, Any]:
        name = call["name"]
        input_data = call["input"]
        call_id = call["id"]
        
        try: 
            if name == 'read_gmail':
              sources_used.append('Gmail')
            # Smart date detection from the user's question
              question_lower = " ".join(
                m.get("content", "") for m in messages
               ).lower()
    
              if "today" in question_lower:
                date_filter = "today"
                fetch_count = 20
              elif "last email" in question_lower or "latest email" in question_lower:
                date_filter = None
                fetch_count = 1
              elif "last 2" in question_lower or "2 email" in question_lower:
                date_filter = None
                fetch_count = 2
              elif "last 3" in question_lower or "3 email" in question_lower:
                date_filter = None
                fetch_count = 3
              elif "last 5" in question_lower or "5 email" in question_lower:
                date_filter = None
                fetch_count = 5
              else:
                date_filter = None
                fetch_count = 10

              emails = await get_recent_emails(google_access_token, fetch_count, date_filter)
                # Truncate body to avoid context overflow
              for e in emails:
                e["body"] = (e.get("body") or e.get("snippet") or "")[:500]
              return {"id": call_id, "name": name, "resultData": format_emails_for_context(emails)}

            if name == 'read_calendar':
                sources_used.append('Calendar')
                events = await get_upcoming_events(google_access_token, 10)
                return {"id": call_id, "name": name, "resultData": format_events_for_context(events)}

            if name == 'create_calendar_event':
                sources_used.append('Calendar')
                event = await create_calendar_event(
                    google_access_token,
                    input_data.get("title"),
                    input_data.get("startTime"),
                    input_data.get("endTime"),
                    input_data.get("description", ""),
                    timezone
                )
                return {"id": call_id, "name": name, "resultData": f"Success: \"{event['title']}\" created from {event['start']} to {event['end']}."}

            if name == 'read_tasks':
                sources_used.append('Tasks')
                tasks = await get_tasks(google_access_token, 15)
                return {"id": call_id, "name": name, "resultData": format_tasks_for_context(tasks)}

            if name == 'create_task':
                sources_used.append('Tasks')
                new_task = await create_task(google_access_token, input_data.get("title"), input_data.get("notes", ""))
                return {"id": call_id, "name": name, "resultData": f"Success: Task \"{new_task['title']}\" created."}

            if name == 'read_google_sheets':
                sources_used.append('Sheets')
                raw_id = (input_data.get("spreadsheetId") or "").strip()
                import re
                match = re.search(r"/d/([\w-]+)", raw_id)
                spreadsheet_id = match.group(1) if match else raw_id

                range_str = input_data.get("range") or "A1:Z200"
                if input_data.get("sheetName"):
                    range_str = f"'{input_data['sheetName']}'!{range_str}"

                print(f"[Sheets] ID: \"{spreadsheet_id}\", Range: \"{range_str}\"")
                rows = await read_sheet_range(google_access_token, spreadsheet_id, range_str)
                return {"id": call_id, "name": name, "resultData": format_sheet_for_context(rows)}

            if name == 'list_drive_files':
                sources_used.append('Drive')
                max_res = input_data.get("maxResults") or 50
                files = await list_all_drive_files(google_access_token, max_res)
                return {"id": call_id, "name": name, "resultData": format_files_for_context(files)}

            if name == 'search_google_drive':
                sources_used.append('Drive')
                files = await search_drive_files(google_access_token, input_data.get("searchQuery"), 20)
                return {"id": call_id, "name": name, "resultData": format_files_for_context(files)}

            if name == 'read_google_doc':
                sources_used.append('Google Docs')
                doc_content = await read_google_doc(google_access_token, input_data.get("fileId"))
                if not doc_content or len(doc_content) < 10:
                    raise ValueError("Document is empty or inaccessible.")
                return {"id": call_id, "name": name, "resultData": doc_content[:6000]}

            return {"id": call_id, "name": name, "resultData": "Unknown tool"}
            
        except Exception as err:
            print(f"[Tool error] {name}: {str(err)}")
            return {"id": call_id, "name": name, "resultData": f"Error: {str(err)}"}

    # Execute all generated tool calls concurrently using asyncio.gather
    tool_results = await asyncio.gather(*(run_single_tool(call) for call in tool_calls))

    # ── Error Check ──────────────────────────────────────────────────
    for tr in tool_results:
        if tr["resultData"].startswith("Error:"):
            return {"answer": f"I had trouble accessing your data: {tr['resultData']}", "source": "Error"}

    # Assemble final payload
    formatted_tool_results = []
    for tr in tool_results:
        formatted_tool_results.append({
            "role": "tool",
            "tool_call_id": tr["id"],
            "name": tr["name"],
            "content": tr["resultData"]
        })

    final_messages = messages + [raw_message] + formatted_tool_results

    # Context window protection check
    total_chars = sum(len(m.get("content") or "") for m in final_messages)
    if total_chars > 20000:
        truncated_messages = []
        for m in final_messages:
            if m.get("role") == "tool" and m.get("content") and len(m["content"]) > 4000:
                m["content"] = m["content"][:4000] + "\n...[content truncated to fit context]"
            truncated_messages.append(m)
        final_messages = truncated_messages
        print(f"[Agent] Content truncated from {total_chars} chars for Groq compatibility")

    final_res = await synthesise(final_messages, SYSTEM_PROMPT)

    return {
        "answer": final_res.get("text") or "Done.",
        "source": ", ".join(list(set(sources_used)))
    }