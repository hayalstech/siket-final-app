# Lottery TMA - Render.com Deployment

## Quick Setup

1. Push render.yaml to git
2. Connect repository in Render
3. Configure environment variables
4. Deploy! 🚀

## Environment Variables Needed

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
TELEGRAM_BOT_TOKEN=your_bot_token
```

## Render Configuration

- Service Type: Static Site
- Publish Directory: public
- Build Command: (leave empty)
- Auto-deploy: Yes (on git push)

## Deploy URL Format

Your app will be available at:
`https://siket-lottery-tma.onrender.com`

## Post-Deployment Steps

1. Update Telegram Bot Web App URL
2. Test all functionality
3. Configure custom domain (optional)
4. Set up monitoring

## Advantages of Render

✅ Free static site hosting
✅ Built-in HTTPS and security
✅ Automatic deployments from GitHub
✅ Custom domain support
✅ Environment variables
✅ Global CDN distribution
