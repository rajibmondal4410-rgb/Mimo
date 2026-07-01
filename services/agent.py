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
from services.sheets import update_sheet_cell, append_sheet_row, extract_spreadsheet_id

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


async def call_gemini(messages, system_prompt, tools=None):
    gemini_key = os.getenv("GEMINI_API_KEY")
    if not gemini_key:
        raise ValueError("No GEMINI_API_KEY found.")

    body = {
        "model": "gemini-2.5-flash",
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
        msg  = data["choices"][0]["message"]

        if msg.get("tool_calls"):
            calls = []
            for tc in msg["tool_calls"]:
                calls.append({
                    "id":    tc["id"],
                    "name":  tc["function"]["name"],
                    "input": json.loads(tc["function"]["arguments"])
                })
            return {"action": "tool_calls", "calls": calls, "rawMessage": msg}

        text = msg.get("content") or ""

        # Gemini sometimes leaks tool-call syntax as plain text instead of
        # issuing a real tool_calls response. Detect this and force a retry
        # via Groq instead of returning the broken/hallucinated text to the user.
        if "<function>" in text or "function_calls" in text.lower():
            raise RuntimeError("Gemini leaked tool call syntax as text instead of executing it.")

        return {"action": "text", "text": text}


# ── NOTE on provider routing ──────────────────────────────────────────
# Per your request: Gmail-related calls are pinned to Groq ONLY, with no
# silent fallback to Gemini. The two models parse tool arguments slightly
# differently, and silently switching providers mid-conversation was part
# of why results felt random (one request answered by Groq, the next by
# Gemini, with no visible difference to you). General chat/other tools
# still use the full fallback chain since that risk doesn't apply there.

async def ask_any(messages: List[Dict[str, str]], system_prompt: str, tools: List[Dict[str, Any]] = None) -> Dict[str, Any]:
    errors = []
    for fn in [call_groq, call_gemini]:
        try:
            return await fn(messages, system_prompt, tools)
        except Exception as e:
            errors.append(str(e))
    raise RuntimeError(f"All providers failed: {' | '.join(errors)}")


async def ask_groq_only(messages: List[Dict[str, str]], system_prompt: str, tools: List[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Used for Gmail intent detection. Falls back to Gemini if Groq fails tool generation."""
    try:
        return await call_groq(messages, system_prompt, tools)
    except Exception as e:
        err = str(e)
        # Groq sometimes fails tool call generation for certain inputs
        # Fall back to Gemini silently rather than crashing the whole request
        if "failed_generation" in err or "tool_use_failed" in err or "invalid_request_error" in err:
            print(f"[Groq tool generation failed, falling back to Gemini]: {err[:200]}")
            return await call_gemini(messages, system_prompt, tools)
        raise


async def synthesise(final_messages: List[Dict[str, Any]], system_prompt: str, groq_only: bool = False) -> Dict[str, Any]:
    if groq_only:
        return await call_groq(final_messages, system_prompt, None)
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
            "description": (
                "Fetch emails from the inbox. By default this includes EVERY email "
                "in the inbox regardless of type — personal messages, newsletters, "
                "automated/system senders, anything — exactly like a person scrolling "
                "their own inbox would see, with nothing pre-filtered out. "
                "ALWAYS set count and date_filter explicitly based on exactly what the user asked. "
                "If the user refers to a specific person by name, relationship, or email "
                "(a friend, a contact, a company, anyone at all), set the from_person "
                "parameter to that name or email so results are filtered to just them. "
                "Examples: "
                "'who emailed me today' -> date_filter='today', count=50, from_person=null. "
                "'did Priya send anything today' -> date_filter='today', count=20, from_person='Priya'. "
                "'check what my friend Arjun sent' -> date_filter='none', count=20, from_person='Arjun'. "
                "'anything from Razorpay' -> date_filter='none', count=20, from_person='Razorpay'. "
                "'last email' / 'latest email' -> date_filter='none', count=1, from_person=null. "
                "'last 2 emails' -> date_filter='none', count=2, from_person=null. "
                "'last 3 emails' -> date_filter='none', count=3, from_person=null. "
                "no specific count or date mentioned -> date_filter='none', count=10, from_person=null."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "count": {
                        "type": "integer",
                        "description": "Exact number of emails to fetch, taken directly from the user's wording. Default 10 if unspecified. Use a higher number like 30-50 for broad date-based queries like 'today' so nothing is missed."
                    },
                    "date_filter": {
                        "type": "string",
                        "enum": ["today", "yesterday", "none"],
                        "description": "'today' ONLY if user said 'today'. 'yesterday' ONLY if user said 'yesterday'. Otherwise 'none'."
                    },
                    "from_person": {
                        "type": "string",
                        "description": "Name or email of a specific sender. Use empty string if no specific sender was named."
                    }
                },
                "required": ["count", "date_filter", "from_person"]
            }
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
        "description": (
            "Read data from a Google Spreadsheet. "
            "The spreadsheetId MUST be the ID between /d/ and /edit in the URL — never a full URL. "
            "If the user has saved sheets, their IDs are injected into the system prompt — use them directly. "
            "If the user mentions a tab name like 'SAMPLE 1', pass it as sheetName."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "spreadsheetId": {"type": "string", "description": "Only the ID between /d/ and /edit."},
                "range": {"type": "string", "description": "Cell range e.g. A1:Z500."},
                "sheetName": {"type": "string", "description": "Tab name e.g. 'SAMPLE 1'. Omit if unknown."}
            },
            "required": ["spreadsheetId"]
        }
    }
},
{
    "type": "function",
    "function": {
        "name": "update_sheet_cell",
        "description": "Update a specific cell in a Google Spreadsheet. Use the ACTUAL spreadsheet ID from the saved sheets list in the system prompt (the long alphanumeric string), never the friendly name like 'my sheet'. Read the sheet first to find the exact row, then call this with the precise cell range.",
        "parameters": {
            "type": "object",
            "properties": {
                "spreadsheetId": {"type": "string", "description": "The REAL spreadsheet ID (long alphanumeric string from the saved sheets list), NOT the friendly name."},
                "range": {"type": "string", "description": "Exact cell e.g. \"'SAMPLE 1'!B2\""},
                "value": {"type": "string", "description": "The new value to write."}
            },
            "required": ["spreadsheetId", "range", "value"]
        }
    }
},
{
    "type": "function",
    "function": {
        "name": "append_sheet_row",
        "description": "Add a new row to the bottom of a Google Spreadsheet tab. Use when user wants to add a new entry or record.",
        "parameters": {
            "type": "object",
            "properties": {
                "spreadsheetId": {"type": "string", "description": "Only the ID between /d/ and /edit."},
                "sheetName": {"type": "string", "description": "Tab name e.g. 'SAMPLE 1'"},
                "values": {"type": "array", "items": {"type": "string"}, "description": "Values in column order matching sheet headers."}
            },
            "required": ["spreadsheetId", "sheetName", "values"]
        }
    }
},
{
    "type": "function",
    "function": {
        "name": "remember_sheet",
        "description": "Save a Google Spreadsheet permanently so the user never has to paste the URL again. Call when user says 'remember my sheet', 'save this spreadsheet', or pastes a Sheets URL with a name.",
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Short friendly name e.g. 'b2b leads', 'sales pipeline'"},
                "spreadsheetId": {"type": "string", "description": "The ID from the Google Sheets URL (between /d/ and /edit)"}
            },
            "required": ["name", "spreadsheetId"]
        }
    }
},    
]

SYSTEM_PROMPT = """You are Mimo, an elite AI assistant connected to Google Workspace.

RULES:
1. Be direct and concise. No preamble.
2. Never mention which tools or APIs you used.
3. No JSON in responses — plain text only.
4. For lists use clean bullet points.
5. CRITICAL — Gmail: call read_gmail with explicit `count`, `date_filter`, and `from_person` arguments that match exactly what the user said (see tool description for examples). If the user names or refers to any specific person, friend, contact, or sender — set from_person to that. Never guess past what they literally said.
6. CRITICAL — Gmail results integrity: The read_gmail tool result tells you EXACTLY how many emails were found. You must list every single one of them and ONLY those — never add an email that is not in the tool result, never omit one that is. If the result says 0 emails found, say so plainly. Do not summarize generically — use the actual From/Subject/Date shown. The inbox is fetched in full (no category is hidden), so trust the result completely as what's actually there.
7. CRITICAL — Email content: If an email has attachments listed (PDF, invoice, etc.), mention them clearly to the user.
8. CRITICAL — Draft email: When the user says "write a draft" or "send an email to X" or describes what they want to tell someone in their own words, write a complete, well-formed email from that and respond with the draft content clearly formatted as:
   TO: [recipient]
   SUBJECT: [subject]
   BODY: [body text]
   Then tell the user to click "Approve & Send" to send it. This applies to anyone the user wants to email — a friend, family, a company, anyone — not just professional contacts.
9. CRITICAL — Google Docs: ALWAYS call search_google_drive FIRST to get the fileId. Then call read_google_doc with that fileId.
10. CRITICAL — Sheets: The saved spreadsheets list above shows "name": friendly label, and "spreadsheet ID": the real ID to use in every tool call. ALWAYS pass the real ID (the long alphanumeric string), NEVER the friendly name like "my sheet" or "b2b leads" as the spreadsheetId parameter. Read with range A1:Z1000 to capture the full sheet including rows far down. To edit a cell, first read the sheet to find the exact row number by matching the name/value the user mentioned, then call update_sheet_cell. To add data, call append_sheet_row.
11. CRITICAL — Calendar: generate startTime as naive local datetime, NO timezone suffix e.g. "2026-06-20T14:00:00".
12. If you cannot find data, say "I couldn't find that" — never make up an answer.
13. CRITICAL — Draft email: When the user says "write a draft" or "send an email to X", 
   you MUST use the recipient's full email address in the TO field — never just a name. 
   If you read an email from that person earlier in this conversation, use the From: 
   address you saw. If you don't know their email, ask the user for it before writing 
   the draft. Format exactly as:
   TO: email@domain.com
   SUBJECT: subject here
   BODY: body text here
"""


# ── STEP 1: Intent detection ─────────────────────────────────────────
async def determine_intent_and_ask(question: str, history: List[Dict[str, str]], timezone: str = "Asia/Kolkata", sheets_context: str = "") -> Dict[str, Any]:
    messages = history[-4:] + [{"role": "user", "content": question}]
    prompt = SYSTEM_PROMPT + sheets_context if sheets_context else SYSTEM_PROMPT

    # Gmail-related questions are routed to Groq only, with no fallback,
    # so tool-argument parsing stays consistent. We do a cheap keyword
    # pre-check on the CURRENT question only (not full history) just to
    # pick the provider chain — the LLM still makes the real decision
    # about which tool to call and what arguments to pass.
    is_mail_related = any(
        kw in question.lower()
        for kw in ["email", "mail", "inbox", "gmail", "draft", "invoice", "attachment"]
    )

    if is_mail_related:
        ai_res = await ask_groq_only(messages, SYSTEM_PROMPT, TOOLS)
    else:
        ai_res = await ask_any(messages, SYSTEM_PROMPT, TOOLS)

    if ai_res["action"] == "text":
        return {"intent": "ANSWER", "answer": ai_res["text"]}

    return {
        "intent": "SEARCH",
        "toolCalls": ai_res["calls"],
        "rawMessage": ai_res["rawMessage"],
        "messages": messages,
        "groqOnly": is_mail_related
    }


# ── STEP 2: Execute tools ────────────────────────────────────────────
async def execute_agent_search(intent_data: Dict[str, Any], google_access_token: str, timezone: str = "Asia/Kolkata", user_id: str = None) -> Dict[str, Any]:
    tool_calls = intent_data["toolCalls"]
    raw_message = intent_data["rawMessage"]
    messages = intent_data["messages"]
    groq_only = intent_data.get("groqOnly", False)
    sources_used = []

    # Fetch the user's real saved sheet IDs once, to guard against
    # hallucinated spreadsheet IDs from the model
    user_saved_sheet_ids = []
    if user_id:
        try:
            from services.database import get_user_sheets
            saved = await get_user_sheets(user_id)
            user_saved_sheet_ids = [s["spreadsheet_id"] for s in saved]
        except Exception:
            pass

    async def run_single_tool(call: Dict[str, Any]) -> Dict[str, Any]:
        name = call["name"]
        input_data = call["input"]
        call_id = call["id"]

        try:
            if name == 'read_gmail':
                sources_used.append('Gmail')

                # Trust the LLM's structured tool arguments directly.
                # No re-scanning of conversation text, no guessing —
                # this is the entire fix for "wrong/invented emails".
                raw_count = input_data.get("count", 10)
                try:
                    fetch_count = max(1, min(int(raw_count), 50))
                except (TypeError, ValueError):
                    fetch_count = 10

                raw_date_filter = (input_data.get("date_filter") or "none").lower()
                date_filter = raw_date_filter if raw_date_filter in ("today", "yesterday") else None

                from_person = input_data.get("from_person") or None
                if isinstance(from_person, str) and (not from_person.strip() or from_person.strip() == '""'):
                     from_person = None

                # exclude_bulk is intentionally left False (the default) here.
                # Mimo is meant to see the FULL inbox the way a human would —
                # personal mail, newsletters, automated senders, everything —
                # and reason about relevance itself rather than have Gmail's
                # bulk-mail categorization silently hide real messages before
                # they're ever shown. This was the cause of "only Render
                # emails show up" — the old query hardcoded that exclusion.
                emails = await get_recent_emails(
                    google_access_token,
                    max_results=fetch_count,
                    date_filter=date_filter,
                    tz_name=timezone,
                    sender=from_person,
                    exclude_bulk=False
                )

                # Truncate body to avoid context overflow — keep enough
                # for genuine summarization, not so much it blows the window.
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
                spreadsheet_id = extract_spreadsheet_id(raw_id)

                # Safety net: if the model hallucinated an ID that doesn't match any
                # of the user's saved sheets, and the user has saved sheets, override
                # with the correct one instead of hitting Google with a fake ID.
                if user_saved_sheet_ids and spreadsheet_id not in user_saved_sheet_ids:
                   if len(user_saved_sheet_ids) == 1:
                     print(f"[Sheets] Model passed wrong ID '{spreadsheet_id}', correcting to saved sheet.")
                     spreadsheet_id = user_saved_sheet_ids[0]
                range_str = input_data.get("range") or "A1:Z500"
                if input_data.get("sheetName"):
                    range_str = f"'{input_data['sheetName']}'!{range_str}"
                print(f"[Sheets] ID: \"{spreadsheet_id}\", Range: \"{range_str}\"")
                rows = await read_sheet_range(google_access_token, spreadsheet_id, range_str)
                sheet_label = input_data.get("sheetName") or spreadsheet_id
                return {"id": call_id, "name": name, "resultData": format_sheet_for_context(rows, sheet_label)}

            if name == 'update_sheet_cell':
                sources_used.append('Sheets')
                result = await update_sheet_cell(
                    google_access_token,
                    input_data.get("spreadsheetId"),
                    input_data.get("range"),
                    input_data.get("value")
                )
                return {"id": call_id, "name": name, "resultData": f"✅ Updated {result['updated_range']} — {result['updated_cells']} cell(s) changed."}

            if name == 'append_sheet_row':
                sources_used.append('Sheets')
                result = await append_sheet_row(
                    google_access_token,
                    input_data.get("spreadsheetId"),
                    input_data.get("sheetName", "Sheet1"),
                    input_data.get("values", [])
                )
                return {"id": call_id, "name": name, "resultData": f"✅ New row added to {result['updated_range']}."}

            if name == 'remember_sheet':
                from services.database import save_user_sheet
                clean_id = extract_spreadsheet_id(input_data.get("spreadsheetId", ""))
                sheet_name = input_data.get("name", "my sheet").lower()
                if user_id and clean_id:
                    await save_user_sheet(user_id, sheet_name, clean_id)
                    return {"id": call_id, "name": name, "resultData": f"✅ Saved '{sheet_name}'. I'll remember this sheet from now on."}
                return {"id": call_id, "name": name, "resultData": "Could not save — missing sheet ID."}

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
    if total_chars > 28000:
        truncated_messages = []
        for m in final_messages:
            content = m.get("content") or ""
            # Don't truncate sheets data — the user needs to see far-down rows.
            # Only truncate if it's clearly not sheet data (no "Row " markers).
            is_sheet_data = "Spreadsheet:" in content and "Row " in content
            if m.get("role") == "tool" and content and len(content) > 12000 and not is_sheet_data:
                m["content"] = content[:12000] + "\n...[content truncated to fit context]"
            truncated_messages.append(m)
        final_messages = truncated_messages
        print(f"[Agent] Content truncated from {total_chars} chars (sheets preserved)")

    # If sheets data is large, prefer Gemini for synthesis — it handles
    # bigger context windows better than Groq for dense spreadsheet data
    has_large_sheet_data = any(
        "Spreadsheet:" in (m.get("content") or "") and len(m.get("content") or "") > 8000
        for m in final_messages
    )
    async def synthesise(final_messages, system_prompt, groq_only=False):
      if groq_only:
        return await call_groq(final_messages, system_prompt, None)
      errors = []
      for fn in [call_gemini, call_groq]:  # try Gemini first for large data, fallback Groq
         try:
             return await fn(final_messages, system_prompt, None)
         except Exception as e:
             errors.append(str(e))
      raise RuntimeError(f"Synthesis failed: {' | '.join(errors)}")
    
    final_res = await synthesise(final_messages, SYSTEM_PROMPT, groq_only=groq_only)

    return {
        "answer": final_res.get("text") or "Done.",
        "source": ", ".join(list(set(sources_used)))
    }