Deploying Siket Lotto (frontend) to Vercel

This document shows simple, copy-paste steps for deploying the static frontend in `/public` to Vercel, plus notes for the backend and production checks.

1) Quick local sanity checks

- Start a local static server (serves `public/`):

```powershell
node scripts/dev_server.js
# or
npx http-server public -p 8081 -c-1
```

- In another terminal run the headless check:

```powershell
$env:URL='http://127.0.0.1:8081'; node tests/headless_check.js
```

Confirm the page loads, the hero text is visible, and modals behave.

2) Deploy frontend to Vercel (recommended)

Option A — Quick (Vercel CLI)

```bash
# install CLI (if needed)
npm i -g vercel
vercel login
# From repo root:
vercel --prod
```

When prompted, choose the Git repository or link the project. When asked for the "publish directory" or build step, set the publish directory to `public` (no build required for static site).

Option B — GitHub integration (recommended for CI)

- Go to https://vercel.com, sign in and click "New Project" -> Import Git Repository.
- Choose your repo and, when configuring, set the "Build & Output Settings" / "Framework" to "Other" and set the "Output Directory"/Publish to `public`.
- Deploy.

3) Environment & Backend notes

- The frontend is static. Your Node bot / API (`bot.js`) must be deployed separately to a Node host (Railway, Fly, Heroku, DigitalOcean App Platform, etc.).
- Required backend environment variables (check `bot.js` for exact names):
  - `DATABASE_URL` — Postgres connection string
  - `BOT_TOKEN` — Telegram bot token
  - `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (optional)
- Configure CORS on your backend to allow requests from your Vercel domain (e.g., https://your-site.vercel.app).

4) Telegram WebApp

- If you use Telegram WebApp integration, set the WebApp URL in BotFather or your bot settings to the deployed Vercel URL.
- Test within Telegram (open your bot and click the Web App button).

5) Post-deploy checks

- Visit the deployed URL and test:
  - Language toggle
  - Theme toggle
  - Register / Sign-in flow (localStorage)
  - Grid selection -> betslip -> Pay modal (this will call API; ensure backend or mock is available)
- If you want me to run the headless check against the deployed URL, provide the URL and I will run it and return a screenshot and console logs.

6) Troubleshooting

- If fetch calls fail with CORS errors, either:
  - Serve frontend from the same domain as backend (via reverse proxy), or
  - Update backend CORS allowed origins to include your frontend domain.

--
If you'd like, I can also:
- Run the local HTTP headless check now, or
- Create a short `vercel.json` with redirects/rewrite rules (if you need `/api/*` proxied to a backend URL).

If you want me to deploy for you via the Vercel CLI, give me permission to run `vercel` with your account (I cannot access credentials), otherwise follow Option A or B above.
