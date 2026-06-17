const { google } = require('googleapis');

/**
 * Searches Google Drive for files matching a text query.
 * Searches both file names and full text content.
 *
 * @param {string} accessToken  — Google access token from JWT
 * @param {string} query        — search text
 * @param {number} maxResults   — how many files to fetch (default 10)
 * @returns {Array} clean file objects
 */
async function searchDriveFiles(accessToken, query, maxResults = 10) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const drive = google.drive({ version: 'v3', auth });

  const safeQuery = query.replace(/'/g, "\\'");

  const res = await drive.files.list({
    q:        `fullText contains '${safeQuery}' and trashed = false`,
    pageSize: maxResults,
    fields:   'files(id, name, mimeType, modifiedTime, webViewLink)',
    orderBy:  'modifiedTime desc',
  });

  return (res.data.files || []).map(f => ({
    id:           f.id,
    name:         f.name,
    mimeType:     f.mimeType,
    modifiedTime: f.modifiedTime,
    link:         f.webViewLink,
  }));
}

/**
 * Reads the plain text content of a Google Doc by file ID.
 * Uses Drive's export endpoint — only works for native Google Docs
 * (not PDFs, images, or other binary file types).
 *
 * @param {string} accessToken
 * @param {string} fileId
 * @returns {string} plain text content of the doc
 */
async function readGoogleDoc(accessToken, fileId) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'text' }
  );

  return res.data || '';
}

/**
 * Formats Drive search results into a clean text block for Claude.
 */
function formatFilesForContext(files) {
  if (!files.length) return 'No matching files found in Drive.';

  return files.map((f, i) =>
    `File ${i + 1}:
  Name:     ${f.name}
  Type:     ${f.mimeType}
  Modified: ${f.modifiedTime}
  Link:     ${f.link}`
  ).join('\n\n');
}

module.exports = { searchDriveFiles, readGoogleDoc, formatFilesForContext };