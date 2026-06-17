const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { upsertUser } = require('../services/supabase');

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

router.get('/google', (req, res) => {
  const oauth2 = getOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',   // required to get a refresh_token
    prompt:      'consent',   // forces Google to issue refresh_token every time
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
  });
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect('/auth/success?error=true');
  }

  try {
    const oauth2 = getOAuthClient();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
    const { data: googleUser } = await oauth2Api.userinfo.get();

    // ── Save / update this user in Supabase ──────────────
    // This is the key fix: the refresh_token is stored permanently.
    // Next time their access_token expires, we silently refresh it
    // using this stored refresh_token — no re-login needed.
    const savedUser = await upsertUser({
      email:        googleUser.email,
      name:         googleUser.name,
      picture:      googleUser.picture,
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token || null, // only present on first consent
      expiry:       tokens.expiry_date || null,
    });

    // ── JWT now only carries the Supabase user ID ────────
    // Lightweight, never expires Google tokens stored inside it.
    // Every request looks up fresh token data from Supabase.
    const mimoToken = jwt.sign(
      { userId: savedUser.id, email: savedUser.email },
      process.env.JWT_SECRET,
      { expiresIn: '90d' } // long-lived since real auth lives in Supabase now
    );

    res.redirect(`http://localhost:3000/auth/success?token=${mimoToken}&name=${encodeURIComponent(savedUser.name)}`);
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.redirect('/auth/success?error=true');
  }
});

router.get('/success', (req, res) => {
  const { error, name } = req.query;
  if (error) return res.send('<h2 style="font-family:sans-serif; text-align:center;">Login failed.</h2>');

  res.send(`
    <div style="font-family:sans-serif; text-align:center; margin-top:100px;">
      <h2 style="color:#2d2560;">✅ Mimo connected!</h2>
      <p style="color:#8a8070;">Welcome, ${name}. Saving your secure token...</p>
    </div>
  `);
});

module.exports = router;