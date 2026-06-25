import asyncio
from typing import List, Dict, Any
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

async def read_sheet_range(access_token: str, spreadsheet_id: str, range_name: str = "A1:Z200") -> List[List[Any]]:
    """Reads a specific range of data from a Google Spreadsheet."""
    creds = Credentials(token=access_token)

    def read_sync() -> List[List[Any]]:
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
        
        res = service.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id,
            range=range_name
        ).execute()
        
        return res.get("values", [])

    return await asyncio.to_thread(read_sync)


async def get_spreadsheet_meta(access_token: str, spreadsheet_id: str) -> Dict[str, Any]:
    """Fetches the spreadsheet title and the names of all individual tabs/sheets."""
    creds = Credentials(token=access_token)

    def meta_sync() -> Dict[str, Any]:
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
        
        res = service.spreadsheets().get(
            spreadsheetId=spreadsheet_id
        ).execute()
        
        title = res.get("properties", {}).get("title", "")
        
        # Safely extract all sheet tab names
        sheets_data = res.get("sheets", [])
        sheet_names = [s.get("properties", {}).get("title") for s in sheets_data if s.get("properties", {}).get("title")]
        
        return {
            "title": title,
            "sheetNames": sheet_names
        }

    return await asyncio.to_thread(meta_sync)


def format_sheet_for_context(rows: List[List[Any]], sheet_name: str = "Sheet") -> str:
    """
    Formats sheet data so every row is mapped to its exact header columns.
    This prevents the AI from mixing up columns when looking for specific values.
    Each row is rendered as: "Row N: ColumnName: value, ColumnName: value, ..."
    """
    if not rows:
        return f"No data found in {sheet_name}."

    header = rows[0]
    body = rows[1:]

    if not body:
        return "Sheet has headers but no data rows."

    lines = []
    for i, row in enumerate(body):
        cells = []
        for idx, h in enumerate(header):
            # Google Sheets API omits trailing empty cells in a row, 
            # so we must safely check if the index exists to prevent Python IndexErrors.
            val = row[idx] if idx < len(row) else None
            
            if val is not None and str(val).strip() != "":
                cells.append(f"{h}: {val}")
        
        if cells:
            lines.append(f"Row {i + 2}: {' | '.join(cells)}")

    header_str = " | ".join(str(h) for h in header)
    
    return f"Data from {sheet_name} ({len(body)} rows):\nHeaders: {header_str}\n\n" + "\n".join(lines)