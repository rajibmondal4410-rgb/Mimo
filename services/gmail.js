const { google } = require('googleapis');

function extractEmailBody(payload) {
  let body = '';
  if (!payload) return '';
  
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain') {
        body += Buffer.from(part.body.data || '', 'base64').toString('utf8');
      } else if (part.parts) {
        body += extractEmailBody(part);
      }
    }
  } else if (payload.body && payload.body.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  
  return body.trim() || '';
}

async function getRecentEmails(accessToken, maxResults = 15) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId:   'me',
    maxResults,
    // Inbox only — explicitly excludes Promotions, Social, Updates, Spam
    q:        'in:inbox -category:promotions -category:social -category:updates -category:forums',
    labelIds: ['INBOX'],
  });

  const messages = listRes.data.messages;
  if (!messages || messages.length === 0) return [];

  const fetched = await Promise.all(
    messages.map(m =>
      gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' })
    )
  );

  return fetched.map(res => {
    const headers = res.data.payload.headers || [];
    const get = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
    const fullText = extractEmailBody(res.data.payload);

    return {
      id:      res.data.id,
      from:    get('From'),
      subject: get('Subject'),
      date:    get('Date'),
      snippet: res.data.snippet || '',
      isRead:  !res.data.labelIds?.includes('UNREAD'),
      body:    fullText,
    };
  });
}

function formatEmailsForContext(emails) {
  if (!emails.length) return 'No emails found in inbox.';

  return emails.map((e, i) =>
    `Email ${i + 1}:
  From:    ${e.from}
  Subject: ${e.subject}
  Date:    ${e.date}
  Read:    ${e.isRead ? 'Yes' : 'No (unread)'}
  Content: ${(e.body || e.snippet || '').substring(0, 500)}`
  ).join('\n\n');
}

module.exports = { getRecentEmails, formatEmailsForContext };