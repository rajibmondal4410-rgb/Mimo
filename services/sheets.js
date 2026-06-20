const { google } = require('googleapis');

async function readSheetRange(accessToken, spreadsheetId, range = 'A1:Z200') {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return res.data.values || [];
}

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
 * Formats sheet data so every row is mapped to its exact header columns.
 * This prevents the AI from mixing up columns when looking for specific values.
 * Each row is rendered as: "Row N: ColumnName: value, ColumnName: value, ..."
 */
function formatSheetForContext(rows, sheetName = 'Sheet') {
  if (!rows || !rows.length) return `No data found in ${sheetName}.`;

  const [header, ...body] = rows;

  if (!body.length) return `Sheet has headers but no data rows.`;

  const lines = body.map((row, i) => {
    // Map each cell to its exact header name — skip empty cells
    const cells = header
      .map((h, idx) => {
        const val = row[idx];
        if (!val || val.toString().trim() === '') return null;
        return `${h}: ${val}`;
      })
      .filter(Boolean)
      .join(' | ');
    return `Row ${i + 2}: ${cells}`;
  });

  return `Data from ${sheetName} (${body.length} rows):\nHeaders: ${header.join(' | ')}\n\n${lines.join('\n')}`;
}

module.exports = { readSheetRange, getSpreadsheetMeta, formatSheetForContext };