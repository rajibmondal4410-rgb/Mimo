<div align="center">

<img src="https://raw.githubusercontent.com/rajibmondal4410-rgb/Mimo/main/logo.png" width="120" alt="Mimo logo"/>

# Mimo

**Stop switching tabs. Ask Mimo instead.**

Mimo is a personal AI assistant that sits inside your browser, connects directly to your Google Workspace, and answers your questions — without you ever leaving the page you're on.

[Add to Chrome](https://chromewebstore.google.com/detail/njglijkehpdjockbieohgmcagepkbfop) · [Website](https://heymimo.xyz) · [Report a bug](../../issues)

</div>

---

## The problem

If you work with Gmail, Slack, Notion, Drive, and a dozen other tools every day, you already know this feeling:

You're deep in focused work. A notification pulls you to check an email. You open it. You reply. You scroll a little. Fifteen minutes later, you're back — except you're not, because your brain has to rebuild the entire context you just lost.

Knowledge workers switch context hundreds of times a day. Each switch costs real focus, and that focus rarely comes back on its own. The tools we use weren't built to respect that — they were built to pull us in, one tab at a time.

I felt this every single day while building my own startup. So I stopped tolerating it, and built Mimo instead.

## What Mimo does

Mimo lives as a sidebar in your browser. You ask it a question in plain language, and it goes and gets the answer — from your actual data, not a guess.

| You ask | Mimo does |
|---|---|
| "Who emailed me today?" | Reads your Gmail inbox and summarizes it |
| "What's on my calendar?" | Checks Google Calendar for upcoming events |
| "Find the roadmap doc" | Searches Google Drive and opens the file |
| "Remind me to fix the bug" | Creates a Google Task instantly |
| "What's in this spreadsheet?" | Reads and summarizes Google Sheets data |
| Anything else | Answers like a smart, fast, general assistant |

No new tab. No lost context. Just an answer.

## How it works

```
Chrome Extension (sidebar UI)
        │
        ▼
  Node.js / Express backend  ──►  Supabase (auth + token storage)
        │
        ▼
  Multi-provider AI router  ──►  Anthropic → Groq → Gemini → OpenAI
        │
        ▼
  Google Workspace APIs (Gmail, Calendar, Drive, Sheets, Tasks)
```

Mimo authenticates once via Google OAuth, stores a refresh token securely in Supabase, and silently keeps your session alive — no repeated logins, ever. Every question is routed through whichever AI provider is configured, so the assistant keeps working even if one provider goes down.

## Tech stack

- **Extension:** Vanilla JS, Chrome `sidePanel` API, Manifest V3
- **Backend:** Node.js, Express, deployed on Render
- **Auth & storage:** Google OAuth 2.0, Supabase (Postgres)
- **AI:** Multi-provider fallback — Anthropic Claude, Groq, Google Gemini, OpenAI

## Getting started locally

```bash
# Clone the repo
git clone https://github.com/rajibmondal4410-rgb/Mimo.git
cd Mimo/backend

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# fill in your own keys — see .env.example for what's required

# Run the backend
npm run dev
```

Then load the extension:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension` folder
4. Pin Mimo to your toolbar and click to open the sidebar

## Roadmap

- [x] Gmail — read & summarize
- [x] Google Calendar, Drive, Sheets, Tasks
- [x] Multi-provider AI fallback
- [ ] Slack integration
- [ ] Notion integration
- [ ] Voice input & output
- [ ] Native desktop app (Mac & Windows)
- [ ] Long-term memory

## Why open source

This is still day one. Building in the open means real feedback, real accountability, and hopefully, people who want to help shape what Mimo becomes. If you find a bug, have an idea, or want to contribute, open an issue or a pull request — all of it is welcome.

## Contributing

Contributions are what make open source genuinely good. Any contribution you make is appreciated.

1. Fork the project
2. Create your feature branch (`git checkout -b feature/something-great`)
3. Commit your changes (`git commit -m 'Add some feature'`)
4. Push to the branch (`git push origin feature/something-great`)
5. Open a pull request

## License

Distributed under the MIT License. See [`LICENSE`](LICENSE) for more information.

## Connect

Built by [Rajib Mondal](https://x.com/rajibmondalz) — follow along as Mimo grows from a Chrome extension into a true virtual assistant.

<div align="center">

If Mimo saved you a tab switch today, consider giving the repo a ⭐

</div>
