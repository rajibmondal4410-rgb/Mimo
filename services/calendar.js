const { google } = require('googleapis');

/**
 * Fetches upcoming events from Google Calendar.
 * Returns clean objects — no raw Calendar API mess exposed to the rest of the app.
 *
 * @param {string} accessToken  — Google access token from JWT
 * @param {number} maxResults   — how many events to fetch (default 10)
 * @returns {Array} clean event objects
 */
async function getUpcomingEvents(accessToken, maxResults = 10) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.list({
    calendarId:   'primary',
    timeMin:      new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy:      'startTime',
  });

  const events = res.data.items || [];

  return events.map(e => ({
    id:          e.id,
    title:       e.summary || '(No title)',
    start:       e.start?.dateTime || e.start?.date || '',
    end:         e.end?.dateTime   || e.end?.date   || '',
    location:    e.location || '',
    attendees:   (e.attendees || []).map(a => a.email),
    description: e.description || '',
  }));
}

/**
 * Formats events into a clean text block for Claude.
 * Claude reads this as context before answering.
 */
function formatEventsForContext(events) {
  if (!events.length) return 'No upcoming events found.';

  return events.map((e, i) =>
    `Event ${i + 1}:
  Title:     ${e.title}
  Start:     ${e.start}
  End:       ${e.end}
  Location:  ${e.location || 'N/A'}
  Attendees: ${e.attendees.length ? e.attendees.join(', ') : 'N/A'}`
  ).join('\n\n');
}

module.exports = { getUpcomingEvents, formatEventsForContext };