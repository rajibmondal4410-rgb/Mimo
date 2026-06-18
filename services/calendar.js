const { google } = require('googleapis');

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

  return (res.data.items || []).map(e => ({
    id:          e.id,
    title:       e.summary || '(No title)',
    start:       e.start?.dateTime || e.start?.date || '',
    end:         e.end?.dateTime   || e.end?.date   || '',
    location:    e.location || '',
    attendees:   (e.attendees || []).map(a => a.email),
    description: e.description || '',
  }));
}

async function createCalendarEvent(accessToken, title, startTime, endTime, description = '') {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const calendar = google.calendar({ version: 'v3', auth });

  // Parse natural time like "today at 2pm" into ISO strings
  const start = new Date(startTime);
  const end   = endTime ? new Date(endTime) : new Date(start.getTime() + 60 * 60 * 1000); // default 1hr

  const res = await calendar.events.insert({
    calendarId:  'primary',
    requestBody: {
      summary:     title,
      description,
      start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
      end:   { dateTime: end.toISOString(),   timeZone: 'Asia/Kolkata' },
    },
  });

  return {
    id:    res.data.id,
    title: res.data.summary,
    start: res.data.start?.dateTime,
    end:   res.data.end?.dateTime,
    link:  res.data.htmlLink,
  };
}

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

module.exports = { getUpcomingEvents, createCalendarEvent, formatEventsForContext };