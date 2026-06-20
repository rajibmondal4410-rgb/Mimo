const { google } = require('googleapis');

/**
 * Lists ALL files in Google Drive with pagination support.
 * Used when user asks "what files do I have" or "list my drive".
 */
async function listAllDriveFiles(accessToken, maxResults = 50) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    q:        `trashed = false and 'me' in owners`,
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
 * Searches Google Drive using THREE strategies in parallel:
 * 1. Exact file name match
 * 2. Partial name contains
 * 3. Full text content search
 */
async function searchDriveFiles(accessToken, query, maxResults = 20) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth });

  const safeQuery = query.replace(/'/g, "\\'");

  const searches = [
    drive.files.list({
      q:        `name = '${safeQuery}' and trashed = false`,
      pageSize: maxResults,
      fields:   'files(id, name, mimeType, modifiedTime, webViewLink)',
      orderBy:  'modifiedTime desc',
    }),
    drive.files.list({
      q:        `name contains '${safeQuery}' and trashed = false`,
      pageSize: maxResults,
      fields:   'files(id, name, mimeType, modifiedTime, webViewLink)',
      orderBy:  'modifiedTime desc',
    }),
    drive.files.list({
      q:        `fullText contains '${safeQuery}' and trashed = false`,
      pageSize: maxResults,
      fields:   'files(id, name, mimeType, modifiedTime, webViewLink)',
      orderBy:  'modifiedTime desc',
    }),
  ];

  const results = await Promise.allSettled(searches);

  const seen = new Set();
  const merged = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const f of (result.value.data.files || [])) {
        if (!seen.has(f.id)) {
          seen.add(f.id);
          merged.push(f);
        }
      }
    }
  }

  return merged.slice(0, maxResults).map(f => ({
    id:           f.id,
    name:         f.name,
    mimeType:     f.mimeType,
    modifiedTime: f.modifiedTime,
    link:         f.webViewLink,
  }));
}

/**
 * Reads the plain text content of a Google Doc by file ID.
 * Only works for native Google Docs (mimeType: application/vnd.google-apps.document).
 */
async function readGoogleDoc(accessToken, fileId) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth });

  // First verify the file is a Google Doc, not a PDF or video
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType',
  });

  const mimeType = meta.data.mimeType;
  if (mimeType !== 'application/vnd.google-apps.document') {
    return `[This file is a ${mimeType} — Mimo can only read Google Docs as text. PDFs and other formats are not supported yet.]`;
  }

  const res = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'text' }
  );

  return res.data || '';
}

/**
 * Formats file list. Always includes the file ID so the AI
 * can pass it directly to read_google_doc without searching again.
 */
function formatFilesForContext(files) {
  if (!files.length) return 'No matching files found in Drive.';

  return files.map((f, i) =>
    `File ${i + 1}:
  Name:     ${f.name}
  ID:       ${f.id}
  Type:     ${f.mimeType}
  Modified: ${f.modifiedTime}
  Link:     ${f.link}`
  ).join('\n\n');
}

module.exports = { listAllDriveFiles, searchDriveFiles, readGoogleDoc, formatFilesForContext };