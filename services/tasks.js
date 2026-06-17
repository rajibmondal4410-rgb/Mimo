const { google } = require('googleapis');

/**
 * Fetches pending (incomplete) tasks from the user's default Google Tasks list.
 *
 * @param {string} accessToken
 * @param {number} maxResults
 * @returns {Array} clean task objects
 */
async function getTasks(accessToken, maxResults = 20) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const tasks = google.tasks({ version: 'v1', auth });

  const res = await tasks.tasks.list({
    tasklist:      '@default',
    maxResults,
    showCompleted: false,
  });

  return (res.data.items || []).map(t => ({
    id:     t.id,
    title:  t.title,
    notes:  t.notes || '',
    due:    t.due || '',
    status: t.status,
  }));
}

/**
 * Creates a new task in the user's default Google Tasks list.
 * This is the "agentic execution" piece — Mimo writing back to Google, not just reading.
 *
 * @param {string} accessToken
 * @param {string} title
 * @param {string} notes
 * @returns {object} the created task (raw Google Tasks API response)
 */
async function createTask(accessToken, title, notes = '') {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const tasks = google.tasks({ version: 'v1', auth });

  const res = await tasks.tasks.insert({
    tasklist:    '@default',
    requestBody: { title, notes },
  });

  return res.data;
}

/**
 * Formats tasks into a clean text block for Claude.
 */
function formatTasksForContext(taskList) {
  if (!taskList.length) return 'No pending tasks found.';

  return taskList.map((t, i) =>
    `Task ${i + 1}:
  Title: ${t.title}
  Due:   ${t.due || 'No due date'}
  Notes: ${t.notes || 'N/A'}`
  ).join('\n\n');
}

module.exports = { getTasks, createTask, formatTasksForContext };