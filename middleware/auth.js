const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const { getUserById, updateGoogleAccessToken } = require('../services/supabase');

/**
 * Verifies the Mimo JWT, then ensures req.user has a FRESH Google access token.
 *
 * Flow:
 * 1. Verify JWT → get userId
 * 2. Fetch user row from Supabase (has tokens + expiry)
 * 3. If access_token expired → use refresh_token to get a new one silently
 * 4. Save the new access_token back to Supabase
 * 5. Attach everything to req.user
 *
 * This is what eliminates the "login again" problem.
 */
module.exports = async function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided. Please login again.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please login again.' });
  }

  try {
    const user = await getUserById(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: 'User not found. Please login again.' });
    }

    let { google_access_token, google_refresh_token, google_token_expiry } = user;

    // ── Check if Google access token has expired ────────
    const isExpired = !google_token_expiry || Date.now() >= google_token_expiry - 60000; // 1 min buffer

    if (isExpired) {
      if (!google_refresh_token) {
        // No refresh token stored — this only happens if user revoked access
        // or this is a very old account from before Supabase was added.
        return res.status(401).json({ error: 'Gmail access expired. Please reconnect Google.' });
      }

      // ── Silently refresh the access token ──────────────
      const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2.setCredentials({ refresh_token: google_refresh_token });

      const { credentials } = await oauth2.refreshAccessToken();
      google_access_token  = credentials.access_token;
      google_token_expiry  = credentials.expiry_date;

      // Save the fresh token back to Supabase for next time
      await updateGoogleAccessToken(user.id, google_access_token, google_token_expiry);
    }

    // ── Attach clean user data to the request ────────────
    req.user = {
      id:                 user.id,
      email:              user.email,
      name:               user.name,
      googleAccessToken:  google_access_token,
    };

    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    res.status(401).json({ error: 'Session error. Please login again.' });
  }
};