const express = require('express');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const router = express.Router();

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
    access_type:  'offline',
    prompt:       'consent',
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
    const { data: user } = await oauth2Api.userinfo.get();

    const token = jwt.sign(
      {
        email:              user.email,
        name:               user.name,
        picture:            user.picture,
        googleAccessToken:  tokens.access_token,
        googleRefreshToken: tokens.refresh_token || null,
        googleTokenExpiry:  tokens.expiry_date   || null,
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Redirect to the success page with the token in the URL
    res.redirect(`http://localhost:3000/auth/success?token=${token}&name=${encodeURIComponent(user.name)}`);
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.redirect('/auth/success?error=true');
  }
});

// NEW SUCCESS ROUTE
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