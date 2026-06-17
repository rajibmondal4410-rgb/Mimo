const { google } = require('googleapis');

/**
 * Extracts the plain text body from a complex Gmail payload.
 * It searches through the multipart nested structure to find 'text/plain'.
 */
function extractEmailBody(payload) {
  let body = '';
  if (!payload) return '';
  
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain') {
        body += Buffer.from(part.body.data || '', 'base64').toString('utf8');
      } else if (part.parts) {
        body += extractEmailBody(part); // recursive search
      }
    }
  } else if (payload.body && payload.body.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  
  return body.trim() || 'No text body found.';
}

/**
 * Fetches recent emails from Gmail.
 * Now retrieves the FULL email payload so the AI can read deep content.
 *
 * @param {string} accessToken  — Google access token from JWT
 * @param {number} maxResults   — how many emails to fetch (default 15)
 * @returns {Array} clean email objects
 */
async function getRecentEmails(accessToken, maxResults = 15) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const gmail = google.gmail({ version: 'v1', auth });

  // Step 1: get list of message IDs from inbox
  const listRes = await gmail.users.messages.list({
    userId:     'me',
    maxResults,
    q:          'in:inbox',
    labelIds:   ['INBOX'],
  });

  const messages = listRes.data.messages;
  if (!messages || messages.length === 0) return [];

  // Step 2: fetch FULL payload for each message in parallel
  const fetched = await Promise.all(
    messages.map(m =>
      gmail.users.messages.get({
        userId: 'me',
        id:     m.id,
        format: 'full', // CRITICAL UPDATE: Gets the whole email, not just metadata
      })
    )
  );

  // Step 3: parse into clean objects with full body text
  return fetched.map(res => {
    const headers = res.data.payload.headers || [];
    // Fix case-sensitivity issues with headers
    const get = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const fullText = extractEmailBody(res.data.payload);

    return {
      id:      res.data.id,
      from:    get('From'),
      subject: get('Subject'),
      date:    get('Date'),
      snippet: res.data.snippet || '',
      isRead:  !res.data.labelIds?.includes('UNREAD'),
      body:    fullText
    };
  });
}

/**
 * Formats emails into a clean text block for the AI.
 */
function formatEmailsForContext(emails) {
  if (!emails.length) return 'No emails found.';

  return emails.map((e, i) =>
    `Email ${i + 1}:
  From:    ${e.from}
  Subject: ${e.subject}
  Date:    ${e.date}
  Content: ${e.body || e.snippet}` // Use e.body if available, fallback to snippet
  ).join('\n\n');
}

module.exports = { getRecentEmails, formatEmailsForContext };