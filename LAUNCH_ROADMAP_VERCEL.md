# Siket Lottery TMA — Launch Roadmap (Vercel, from Scratch)

This guide takes you from zero to a live production deployment where the **ትኬት ይቁረጡ (Buy Ticket)** button and the **4K Draw Arena** work correctly. Every step is in plain language.

---

## Part A: Final Clarifications (Optional)

Before you start, you may want to confirm these points. If everything below matches your intent, you can proceed without changes.

1. **10×10 grid**
   - Each tier (Gold / Silver / Bronze) has its **own** 100-block grid and its **own** round. Selling 100 Gold blocks does **not** lock Silver or Bronze. Is that correct?
   - Ticket numbers are **1–100** (shown on the grid). The backend stores them as 1–100. Confirm?

2. **EUR/ETB**
   - **1 EUR = 200 ETB** everywhere (admin enters ETB; system converts with floor: `Math.floor(ETB / 200)` for EUR). All internal balance is in **integer cents** where the DB supports it. Correct?
   - Admin approval: you enter the **ETB amount received** and a **bank reference**; the system checks for duplicate bank reference, then credits the user’s EUR balance. Yes?

3. **Draw and prizes**
   - After the **100th** block is sold, a **3-minute (180s)** countdown starts, then the draw runs (3rd → 2nd → 1st). Bronze 3rd gets **2 free tickets** in the next round. Confirm?

4. **Telegram**
   - You have (or will create) a **Telegram Bot** (via BotFather) and a **Telegram group** for winner announcements. The bot will post pool updates and winner messages to that group. The group can be a username (e.g. `@siketlotto`) or a numeric group ID. Correct?

If all of the above is correct, no code changes are required; follow the roadmap below.

---

## Part B: Prerequisites (Before You Start)

- A **GitHub** account and this project in a GitHub repository.
- A **Vercel** account (sign up at [vercel.com](https://vercel.com)).
- A **Telegram Bot** token (from [@BotFather](https://t.me/BotFather)).
- Your **Telegram user ID** (e.g. from [@userinfobot](https://t.me/userinfobot)).
- An **Upstash Redis** database (free tier is enough).
- A **PostgreSQL** database (e.g. Supabase) with the project’s tables and migrations applied.

---

## Part C: Step-by-Step Deployment

### Stage 1 — Upstash Redis

1. Go to [https://upstash.com](https://upstash.com) and sign in (or create an account).
2. Click **Create Database**.
3. Choose a **region** close to your users (e.g. EU if most users are in Ethiopia).
4. Leave **TLS** enabled. Click **Create**.
5. On the database page, open the **REST API** or **Connect** section and copy the **connection string**.
   - It usually looks like:  
     `rediss://default:YOUR_PASSWORD@YOUR_HOST.upstash.io:6379`  
     or in some UIs you see **Redis URL**.
6. Copy this value; you will use it as **REDIS_URL** in Vercel.  
   - If Upstash shows only REST URL and token, note: this app uses the **Redis URL** (node-redis style). Ensure your plan provides a Redis URL; the free tier does.

---

### Stage 2 — Telegram Bot and Admin ID

1. In Telegram, open [@BotFather](https://t.me/BotFather).
2. Send **/newbot** (or use an existing bot with **/mybots** → select bot → API Token).
3. Follow the prompts; copy the **bot token** (e.g. `6123456789:AAH...`). This is your **BOT_TOKEN**.
4. In Telegram, open [@userinfobot](https://t.me/userinfobot), send any message, and copy your **Id** (e.g. `123456789`). This is your **ADMIN_ID** (for admin alerts and approval flows).
5. **(Optional)** Create a **Telegram group** for winner announcements. Add your bot as admin. You can use the group’s **@username** (e.g. `@siketlotto`) or the numeric **group ID** (e.g. `-1001234567890`) as **WINNERS_GROUP_ID**.

---

### Stage 3 — Database (Supabase or other Postgres)

1. Ensure your **PostgreSQL** database is created and reachable from the internet (Supabase does this by default).
2. Run all project **migrations** (e.g. `supabase_setup.sql`, `database_migration.sql`, `migrations/0001_add_cents_columns.sql`, `provably_fair_migration.sql`, etc.) so that tables like `users`, `tiers`, `tickets`, `game_rounds`, `user_wallets`, `draw_seeds`, `winners_history`, `winners_verification`, `deposit_requests`, `transaction_registry` exist.
3. Copy the **connection string** (URI format), e.g.:  
   `postgresql://postgres:YOUR_PASSWORD@db.xxxxx.supabase.co:5432/postgres`  
   This is your **DATABASE_URL**.

---

### Stage 4 — Vercel Project and Environment Variables

1. Go to [https://vercel.com](https://vercel.com) and sign in.
2. Click **Add New…** → **Project**.
3. **Import** your GitHub repository (grant Vercel access to GitHub if asked).
4. Select the repo that contains this project (e.g. `siket-final`).
5. **Do not** change the default **Framework Preset** (Vercel will detect or use “Other”); the project uses **vercel.json** for builds and routes.
6. **Root Directory:** leave as **./** (project root).
7. **Build and Output:** leave as suggested (Vercel uses `vercel.json`: `api/**/*.js` → Node, `public/**/*` → static). No custom build command needed.
8. Before deploying, open **Settings** → **Environment Variables** and add **every** variable below. Use **Production** (and optionally Preview if you want the same for preview deployments).

Add these variables (replace placeholder values with your real ones):

| Name | Value | Notes |
|------|--------|------|
| **BOT_TOKEN** | `6123456789:AAH...` | From BotFather (or use TELEGRAM_BOT_TOKEN) |
| **ADMIN_ID** | `123456789` | Your Telegram user ID from @userinfobot |
| **DATABASE_URL** | `postgresql://...` | Full Postgres connection string |
| **REDIS_URL** | `rediss://default:xxx@xxx.upstash.io:6379` | From Upstash (Redis URL) |
| **WEBHOOK_URL** | `https://YOUR_VERCEL_DOMAIN.vercel.app/api/webhook` | **Set after first deploy** (see Stage 6) |
| **WEBAPP_URL** | `https://YOUR_VERCEL_DOMAIN.vercel.app` | Same base URL as above (for bot menu and links) |
| **WINNERS_GROUP_ID** | `@siketlotto` or `-1001234567890` | Optional; group for pool/winner announcements |
| **EUR_TO_ETB** | `200` | Optional; default is 200 |
| **ADMIN_SECRET** | A long random string | Optional but recommended for `/api/admin/credit-etb` |
| **CRON_SECRET** | A long random string | Optional; for `/api/trigger-draw` and cron endpoints |

**Important:**  
- Do **not** set **WEBHOOK_URL** and **WEBAPP_URL** to the final URL until you know your Vercel URL (e.g. after the first deploy). You can add them in Stage 6 and redeploy.  
- For the **first** deploy you can leave **WEBHOOK_URL** and **WEBAPP_URL** empty or use a placeholder; the site will deploy, but the bot will not receive updates until you set the real URL and activate the webhook (Stage 7).

9. Save all variables. Trigger a **deploy** (Deployments → … → Redeploy, or push a commit after connecting the repo).

---

### Stage 5 — GitHub Push and Vercel Auto-Deploy

1. Ensure your code is on **GitHub** (including `vercel.json`, `api/webhook.js`, `bot.js`, and the `public/` folder).
2. In Vercel, the project is already linked to the repo. So:
   - **Option A (recommended):** Push to the **main** branch. Vercel will build and deploy automatically.
   - **Option B:** If you use the GitHub Action (`.github/workflows/deploy-vercel.yml`), add these **GitHub repository secrets**:  
     **VERCEL_TOKEN**, **VERCEL_ORG_ID**, **VERCEL_PROJECT_ID** (from Vercel → Project Settings → General).
3. After the deploy finishes, open your **Vercel project** → **Deployments** → click the latest deployment → copy the **URL** (e.g. `https://siket-final-xxx.vercel.app`). This is your **production URL**.

---

### Stage 6 — Set WEBHOOK_URL and WEBAPP_URL and Redeploy

1. In Vercel → your project → **Settings** → **Environment Variables**.
2. Set **WEBHOOK_URL** to:  
   `https://YOUR_ACTUAL_VERCEL_URL/api/webhook`  
   Example: `https://siket-final-abc123.vercel.app/api/webhook`.
3. Set **WEBAPP_URL** to:  
   `https://YOUR_ACTUAL_VERCEL_URL`  
   Example: `https://siket-final-abc123.vercel.app`.
4. Save. Go to **Deployments** → **…** on the latest deployment → **Redeploy** (so the new env vars are applied). Wait for the redeploy to finish.

---

### Stage 7 — Manual Webhook Activation (Critical)

The bot receives Telegram updates only when Telegram is told to send them to your server. That is done by **setting the webhook** to your **WEBHOOK_URL**.

**Method 1 — Let the app set it (recommended)**  
- On the **first request** to your server after deploy (e.g. when you open the site or when Telegram sends an update), the app code will try to call `setWebhook(WEBHOOK_URL)` if **WEBHOOK_URL** is set.  
- So after Stage 6, **send a message to your bot** in Telegram (e.g. /start). That triggers Telegram to hit your webhook; your server responds and may set the webhook if not already set.  
- If something went wrong (e.g. env not loaded), use Method 2.

**Method 2 — Set webhook manually via browser**  
1. Open this URL in your browser (replace with your real values):  
   `https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=https://YOUR_VERCEL_URL/api/webhook`  
   Example:  
   `https://api.telegram.org/bot6123456789:AAH.../setWebhook?url=https://siket-final-abc123.vercel.app/api/webhook`
2. You should see a JSON response like: `{"ok":true,"result":true,"description":"Webhook was set"}`.
3. To **delete** the webhook (e.g. to switch back to polling):  
   `https://api.telegram.org/botYOUR_BOT_TOKEN/deleteWebhook`

**Method 3 — BotFather Web App URL (for “Buy Ticket” and 4K Arena)**  
1. In Telegram, open [@BotFather](https://t.me/BotFather).
2. Send **/mybots** → select your bot → **Bot Settings** → **Menu Button** (or **Web App**).
3. Set the **Menu Button URL** (or Web App URL) to:  
   `https://YOUR_VERCEL_URL`  
   so that when users open the bot’s menu or “Open App”, they get your TMA (index.html). This makes the **ትኬት ይቁረጡ** entry point and the 4K Draw Arena (draw.html) work from the bot.

---

### Stage 8 — Verify in Production

1. **Homepage and static files**  
   - Open `https://YOUR_VERCEL_URL`. You should see the Siket Lottery app (logo, header, tiers).  
   - Open `https://YOUR_VERCEL_URL/draw.html?tier=3&round=1`. You should see the 4K Draw Arena (or its loading state).  
   - Open `https://YOUR_VERCEL_URL/countdown.html?tier=3`. You should see the countdown page with the Safe Draw badge.

2. **Bot and webhook**  
   - In Telegram, open your bot and send **/start**. The bot should reply (e.g. welcome + menu with “ትኬት ይቁረጡ | Buy Ticket”).  
   - If it does not reply, check Vercel **Functions** → **api/webhook** logs for errors. Confirm **WEBHOOK_URL** and **BOT_TOKEN** are set correctly and that you set the webhook (Stage 7).

3. **ትኬት ይቁረጡ (Buy Ticket) button**  
   - From the bot, open the **Web App** (menu or “ትኬት ይቁረጡ | Buy Ticket”).  
   - Sign in (or use Telegram initData if you use it).  
   - Select a tier (e.g. Gold), pick a block on the 10×10 grid, and click the main **Buy Ticket / ትኬት ይቁረጡ** (or pay from betslip).  
   - The request goes to **/api/complete-purchase** (multiple blocks) or **/api/purchase-ticket** (single block). You should **not** see “Not Found”; either success or a clear error (e.g. insufficient balance, 409 conflict).  
   - Check **Vercel** → **Functions** → **api/webhook** and any **api** logs for errors.

4. **4K Draw Arena**  
   - When a tier reaches 100 sold blocks, the app should redirect users to the countdown page and then to **draw.html** (3-minute countdown).  
   - Manually open `https://YOUR_VERCEL_URL/draw.html?tier=3&round=1` to confirm the page loads.  
   - Full draw execution requires **POST /api/trigger-draw** (e.g. after 180s); that can be called by a cron job or manually with **CRON_SECRET**. Ensure **REDIS_URL** and **DATABASE_URL** are set so the draw and winner flow work.

5. **Balance and user APIs**  
   - If the app uses **/api/user-balance/:userId**, open the app, sign in, and check that the header balance loads (or shows **** with eye toggle).  
   - Admin flows (deposit approval, credit-etb) require **ADMIN_ID** and optionally **ADMIN_SECRET**.

---

## Part D: Quick Reference — What Lives Where

- **Static site (HTML, CSS, images):** `public/` → served at `https://YOUR_VERCEL_URL/` (e.g. `/`, `/draw.html`, `/countdown.html`, `/verify.html`, `/admin.html`).
- **Backend API and Telegram:** All under **/api/** (e.g. `/api/webhook`, `/api/complete-purchase`, `/api/purchase-ticket`, `/api/user-balance/:userId`, `/api/lockdown/:tierId`, `/api/countdown/:tierId`, `/api/trigger-draw`). Handled by **api/webhook.js** (which loads **bot.js**) on Vercel serverless.

---

## Part E: Troubleshooting

- **“Not Found” on Buy Ticket:** Ensure **WEBHOOK_URL** and **WEBAPP_URL** are set and redeployed; Bot menu URL points to your Vercel URL; and you’re testing from the bot’s Web App (so the correct origin is used). Check Vercel function logs for **/api/purchase-ticket** and **/api/complete-purchase**.
- **Bot not replying:** Webhook not set or wrong URL. Set it manually (Stage 7, Method 2). Check **api/webhook** logs in Vercel.
- **Draw or countdown not working:** Confirm **REDIS_URL** (Upstash) and **DATABASE_URL** are set and that migrations have been run. For the draw to run after 180s, something must call **POST /api/trigger-draw** with the correct **CRON_SECRET** (cron or manual).
- **Balance or DB errors:** Check **DATABASE_URL** and that **user_wallets**, **tickets**, **game_rounds** exist and match the code (e.g. `balance_cents` if used).

---

Following this roadmap from scratch (Upstash + Telegram + DB + Vercel env → GitHub push → set WEBHOOK_URL/WEBAPP_URL → redeploy → manual webhook + Bot menu URL → verify) will get the **ትኬት ይቁረጡ** button and the **4K Draw Arena** fully functional in production.
