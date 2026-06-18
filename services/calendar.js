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

/**
 * Converts a naive datetime string like "2026-06-18T14:00:00"
 * into a proper IST-aware ISO string "2026-06-18T14:00:00+05:30"
 * so Google Calendar stores it correctly as 2 PM IST, not 2 PM UTC.
 */
function toIST(datetimeStr) {
  // If the string already has a timezone offset or Z, use as-is
  if (datetimeStr.endsWith('Z') || datetimeStr.includes('+') || datetimeStr.includes('-', 10)) {
    return datetimeStr;
  }
  // Append IST offset (+05:30)
  return datetimeStr + '+05:30';
}

async function createCalendarEvent(accessToken, title, startTime, endTime = null, description = '') {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const calendar = google.calendar({ version: 'v3', auth });

  const startIST = toIST(startTime);

  let endIST;
  if (endTime) {
    endIST = toIST(endTime);
  } else {
    // Default: 1 hour after start
    const startDate = new Date(startIST);
    const endDate   = new Date(startDate.getTime() + 60 * 60 * 1000);
    // Keep the +05:30 offset
    endIST = endDate.toISOString().replace('Z', '+05:30');
    // Recalculate properly: add 1hr to the IST time string directly
    const [datePart, timePart] = startIST.split('T');
    const [h, m, s]            = timePart.replace('+05:30', '').split(':').map(Number);
    const newH                 = String(h + 1).padStart(2, '0');
    endIST                     = `${datePart}T${newH}:${String(m).padStart(2,'0')}:${String(s||0).padStart(2,'0')}+05:30`;
  }

  const res = await calendar.events.insert({
    calendarId:  'primary',
    requestBody: {
      summary:     title,
      description,
      start: { dateTime: startIST, timeZone: 'Asia/Kolkata' },
      end:   { dateTime: endIST,   timeZone: 'Asia/Kolkata' },
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