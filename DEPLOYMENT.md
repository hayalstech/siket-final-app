# Lottery TMA - Vercel Deployment

## Quick Setup

1. Push vercel.json to git
2. Import repository in Vercel
3. Configure environment variables
4. Deploy! 🚀

## Environment Variables Needed

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

# Telegram (use either BOT_TOKEN or TELEGRAM_BOT_TOKEN)
BOT_TOKEN=your_bot_token
# or: TELEGRAM_BOT_TOKEN=your_bot_token
ADMIN_ID=123456789 (get from @userinfobot)

# Database
DATABASE_URL=your_database_url

# Redis (Essential!)
REDIS_URL=redis://default:password@host.upstash.io:6379

# Webhook (required on Vercel so the bot receives Telegram updates)
WEBHOOK_URL=https://your-project.vercel.app/api/webhook
# Optional: app URL for “keep awake” and derived webhook
# WEBAPP_URL=https://your-project.vercel.app
```

## Getting Required Values

### Admin ID:
1. Open Telegram → Search @userinfobot
2. Send "hi" → Copy your ID

### Redis URL:
1. Go to upstash.com → Create Redis DB
2. Copy connection string

## Post-Deployment Steps

1. Update Telegram Bot Web App URL
2. Test all functionality
3. Verify Redis connection in logs
4. Configure custom domain (optional)

## Deploy URL Format

Your app will be available at:
`https://siket-final-app.vercel.app`
