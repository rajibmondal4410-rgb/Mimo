const { google } = require('googleapis');

/**
 * Reads cell values from a Google Sheet range.
 *
 * @param {string} accessToken
 * @param {string} spreadsheetId — found in the sheet's URL
 * @param {string} range        — e.g. 'Sheet1!A1:Z100' (default reads first 100 rows)
 * @returns {Array<Array<string>>} raw 2D array of cell values, first row = header
 */
async function readSheetRange(accessToken, spreadsheetId, range = 'A1:Z100') {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return res.data.values || [];
}

/**
 * Fetches basic metadata (title + sheet/tab names) for a spreadsheet.
 * Useful when the AI needs to know what tabs exist before picking a range.
 *
 * @param {string} accessToken
 * @param {string} spreadsheetId
 * @returns {object} { title, sheetNames }
 */
async function getSpreadsheetMeta(accessToken, spreadsheetId) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.get({ spreadsheetId });

  return {
    title:      res.data.properties?.title || '',
    sheetNames: (res.data.sheets || []).map(s => s.properties?.title),
  };
}

/**
 * Formats a 2D sheet array into a clean text block for Claude.
 * Assumes the first row is the header row.
 */
function formatSheetForContext(rows, sheetName = 'Sheet') {
  if (!rows.length) return `No data found in ${sheetName}.`;

  const [header, ...body] = rows;

  const lines = body.map((row, i) => {
    const cells = header.map((h, idx) => `${h}: ${row[idx] ?? ''}`).join(', ');
    return `Row ${i + 1}: ${cells}`;
  });

  return `Data from ${sheetName}:\n\n${lines.join('\n')}`;
}

module.exports = { readSheetRange, getSpreadsheetMeta, formatSheetForContext };