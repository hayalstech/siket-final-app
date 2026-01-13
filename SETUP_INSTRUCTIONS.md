# Setup Instructions

## Step 1: Get Your Supabase Connection String

1. Go to your Supabase Dashboard: https://app.supabase.com
2. Select your project
3. Go to **Project Settings** (gear icon) → **Database**
4. Scroll down to **Connection String**
5. Select **URI** tab
6. Copy the connection string (it looks like):
   ```
   postgresql://postgres:[YOUR-PASSWORD]@[PROJECT-REF].supabase.co:5432/postgres
   ```
7. Replace `[YOUR-PASSWORD]` with your actual database password
   - If you forgot your password, click "Reset database password" in Supabase

## Step 2: Create .env File

1. Create a file named `.env` in the root directory (same folder as `bot.js`)
2. Copy the contents from `.env.example`
3. Fill in your actual values:

```env
BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
DATABASE_URL=postgresql://postgres:your_actual_password@abcdefghijklmnop.supabase.co:5432/postgres
ADMIN_ID=123456789
WEBAPP_URL=https://your-domain.com
PORT=3000
```

## Step 3: Run Database Setup SQL

1. Go to Supabase Dashboard → **SQL Editor**
2. Run `supabase_setup.sql` (for fresh setup) OR `supabase_migration_add_payment_requests.sql` (if you already have tables)
3. This creates all necessary tables and enables RLS

## Step 4: Test Connection

When you run `node bot.js`, you should see:
```
✅ Connected to Supabase Cloud Database successfully!
🌐 Siket Production Server Live
```

If you see connection errors, check:
- ✅ `.env` file exists and has correct `DATABASE_URL`
- ✅ Password in connection string is correct
- ✅ Supabase project is active
- ✅ Database password hasn't been reset (which would break the connection)

## Security Notes

- ✅ **Direct Connection**: Your Node.js bot connects directly to Supabase PostgreSQL
- ✅ **No Public API**: RLS is enabled with no policies = lockdown mode
- ✅ **SSL Encrypted**: Connection uses SSL encryption
- ✅ **Environment Variables**: Sensitive data stored in `.env` (never commit this file!)

## Important Files

- `.env` - Your secrets (DO NOT commit to git!)
- `database.js` - Database connection code
- `bot.js` - Main bot and API server
- `supabase_setup.sql` - Database schema setup
