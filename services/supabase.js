/**
 * services/supabase.js — Database layer for Mimo
 *
 * Uses the service_role key (server-side only, never exposed to extension).
 * Stores: user profile + Google/Slack/Notion tokens.
 *
 * This is the ONLY file that talks to Supabase directly.
 * Every other file calls these functions — never the Supabase client directly.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service_role key — full access, server-only
);

/**
 * Creates a new user OR updates an existing one (upsert).
 * Called every time someone logs in with Google.
 *
 * @param {object} googleUser  — { email, name, picture, accessToken, refreshToken, expiry }
 * @returns {object} the saved user row
 */
async function upsertUser(googleUser) {
  const { email, name, picture, accessToken, refreshToken, expiry } = googleUser;

  const payload = {
    email,
    name,
    picture,
    google_access_token: accessToken,
    google_token_expiry: expiry,
  };

  // Only overwrite refresh_token if a new one was given.
  // Google only sends a refresh_token on the FIRST consent —
  // if we overwrite with null on later logins, we lose it forever.
  if (refreshToken) {
    payload.google_refresh_token = refreshToken;
  }

  const { data, error } = await supabase
    .from('mimo_users')
    .upsert(payload, { onConflict: 'email' })
    .select()
    .single();

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  return data;
}

/**
 * Fetches a user by email.
 */
async function getUserByEmail(email) {
  const { data, error } = await supabase
    .from('mimo_users')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  return data;
}

/**
 * Fetches a user by their internal Mimo ID (stored inside the JWT).
 */
async function getUserById(id) {
  const { data, error } = await supabase
    .from('mimo_users')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  return data;
}

/**
 * Updates just the Google access token + expiry after a silent refresh.
 * Called automatically whenever the old access token has expired.
 */
async function updateGoogleAccessToken(userId, accessToken, expiry) {
  const { error } = await supabase
    .from('mimo_users')
    .update({
      google_access_token: accessToken,
      google_token_expiry: expiry,
    })
    .eq('id', userId);

  if (error) throw new Error(`Supabase token update failed: ${error.message}`);
}

module.exports = {
  upsertUser,
  getUserByEmail,
  getUserById,
  updateGoogleAccessToken,
};