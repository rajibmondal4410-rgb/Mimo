import asyncio
import re
from typing import List, Dict, Any, Optional
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build


def extract_spreadsheet_id(raw: str) -> str:
    """
    Extracts the real spreadsheet ID from whatever the LLM passes.
    Handles: full URL, partial URL, or already-clean ID.
    """
    if not raw:
        return raw
    # Extract from /d/{id}/ pattern in URLs
    match = re.search(r'/d/([\w-]+)', raw)
    if match:
        return match.group(1)
    # Already looks like a clean ID (alphanumeric + dashes/underscores, 20+ chars)
    if re.match(r'^[\w-]{20,}$', raw.strip()):
        return raw.strip()
    return raw.strip()


async def read_sheet_range(
    access_token: str,
    spreadsheet_id: str,
    range_name: str = "A1:Z500"
) -> List[List[Any]]:
    """Reads a specific range from a Google Spreadsheet."""
    clean_id = extract_spreadsheet_id(spreadsheet_id)
    creds = Credentials(token=access_token)

    def read_sync() -> List[List[Any]]:
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
        res = service.spreadsheets().values().get(
            spreadsheetId=clean_id,
            range=range_name
        ).execute()
        return res.get("values", [])

    return await asyncio.to_thread(read_sync)


async def get_spreadsheet_meta(
    access_token: str,
    spreadsheet_id: str
) -> Dict[str, Any]:
    """Fetches spreadsheet title and all tab names."""
    clean_id = extract_spreadsheet_id(spreadsheet_id)
    creds = Credentials(token=access_token)

    def meta_sync() -> Dict[str, Any]:
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
        res = service.spreadsheets().get(spreadsheetId=clean_id).execute()
        title = res.get("properties", {}).get("title", "")
        sheets_data = res.get("sheets", [])
        sheet_names = [
            s.get("properties", {}).get("title")
            for s in sheets_data
            if s.get("properties", {}).get("title")
        ]
        return {"title": title, "sheetNames": sheet_names}

    return await asyncio.to_thread(meta_sync)


async def update_sheet_cell(
    access_token: str,
    spreadsheet_id: str,
    range_name: str,
    value: str
) -> Dict[str, Any]:
    """
    Updates a single cell or range in a Google Spreadsheet.
    range_name: e.g. "SAMPLE 1!B2" or "Sheet1!C5"
    value: the new value to write
    """
    clean_id = extract_spreadsheet_id(spreadsheet_id)
    creds = Credentials(token=access_token)

    def update_sync() -> Dict[str, Any]:
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
        body = {"values": [[value]]}
        res = service.spreadsheets().values().update(
            spreadsheetId=clean_id,
            range=range_name,
            valueInputOption="USER_ENTERED",
            body=body
        ).execute()
        return {
            "updated_range": res.get("updatedRange"),
            "updated_cells": res.get("updatedCells"),
        }

    return await asyncio.to_thread(update_sync)


async def append_sheet_row(
    access_token: str,
    spreadsheet_id: str,
    sheet_name: str,
    values: List[Any]
) -> Dict[str, Any]:
    """
    Appends a new row to the bottom of a sheet tab.
    values: list of cell values in order, e.g. ["John", "john@email.com", "Manager"]
    """
    clean_id = extract_spreadsheet_id(spreadsheet_id)
    creds = Credentials(token=access_token)

    def append_sync() -> Dict[str, Any]:
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
        body = {"values": [values]}
        res = service.spreadsheets().values().append(
            spreadsheetId=clean_id,
            range=f"'{sheet_name}'!A1",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body=body
        ).execute()
        return {
            "updated_range": res.get("updates", {}).get("updatedRange"),
            "updated_cells": res.get("updates", {}).get("updatedCells"),
        }

    return await asyncio.to_thread(append_sync)


def format_sheet_for_context(rows: List[List[Any]], sheet_name: str = "Sheet") -> str:
    """
    Formats sheet rows mapped to headers so the LLM can find exact values.
    """
    if not rows:
        return f"No data found in {sheet_name}."

    header = rows[0]
    body   = rows[1:]

    if not body:
        return "Sheet has headers but no data rows."

    lines = []
    for i, row in enumerate(body):
        cells = []
        for idx, h in enumerate(header):
            val = row[idx] if idx < len(row) else None
            if val is not None and str(val).strip():
                cells.append(f"{h}: {val}")
        if cells:
            lines.append(f"Row {i + 2}: {' | '.join(cells)}")

    header_str = " | ".join(str(h) for h in header)
    return (
        f"Spreadsheet: {sheet_name} ({len(body)} data rows)\n"
        f"Headers: {header_str}\n\n"
        + "\n".join(lines)
    )