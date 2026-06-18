const { google } = require('googleapis');

/**
 * Searches Google Drive for files matching a text query.
 * Searches BOTH file name AND full text content, then deduplicates.
 */
async function searchDriveFiles(accessToken, query, maxResults = 10) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth });

  const safeQuery = query.replace(/'/g, "\\'");

  // Run two searches in parallel: one by name, one by content
  const [nameRes, contentRes] = await Promise.all([
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
    })
  ]);

  // Merge and deduplicate by file ID
  const seen = new Set();
  const merged = [];
  for (const f of [...(nameRes.data.files || []), ...(contentRes.data.files || [])]) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      merged.push(f);
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
 * Formats Drive search results into a clean text block for the AI.
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

module.exports = { searchDriveFiles, readGoogleDoc, formatFilesForContext };