const { google } = require('googleapis');

/**
 * Fetches recent emails from Gmail.
 * Returns clean objects — no raw Gmail API mess exposed to the rest of the app.
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

  // Step 2: fetch metadata for each message in parallel
  const fetched = await Promise.all(
    messages.map(m =>
      gmail.users.messages.get({
        userId:          'me',
        id:              m.id,
        format:          'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      })
    )
  );

  // Step 3: parse into clean objects
  return fetched.map(res => {
    const headers = res.data.payload.headers || [];
    const get     = name => headers.find(h => h.name === name)?.value || '';

    return {
      id:      res.data.id,
      from:    get('From'),
      subject: get('Subject'),
      date:    get('Date'),
      snippet: res.data.snippet || '',
      isRead:  !res.data.labelIds?.includes('UNREAD'),
    };
  });
}

/**
 * Formats emails into a clean text block for Claude.
 * Claude reads this as context before answering.
 */
function formatEmailsForContext(emails) {
  if (!emails.length) return 'No emails found in inbox.';

  return emails.map((e, i) =>
    `Email ${i + 1}:
  From:    ${e.from}
  Subject: ${e.subject}
  Date:    ${e.date}
  Read:    ${e.isRead ? 'Yes' : 'No (unread)'}
  Preview: ${e.snippet}`
  ).join('\n\n');
}

module.exports = { getRecentEmails, formatEmailsForContext };