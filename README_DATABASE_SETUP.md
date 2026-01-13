# Database Setup Instructions

## Option 1: Fresh Setup (Recommended)
If you're starting fresh or want to reset everything:

1. Run `supabase_setup.sql` in your Supabase SQL Editor
2. This will:
   - Create all tables from scratch
   - Set up RLS (Row Level Security) on all tables
   - Seed initial data (tiers, rounds, tickets)
   - Create the payment_requests table for admin dashboard

## Option 2: Add to Existing Schema
If you've already run your original schema:

1. Run `supabase_migration_add_payment_requests.sql` in your Supabase SQL Editor
2. This will:
   - Add the payment_requests table
   - Add compatibility columns to tiers table (first_prize, second_prize, third_prize)
   - Enable RLS on payment_requests

## Important Notes

### Row Level Security (RLS)
- All tables have RLS enabled
- **No policies are created** = Lockdown mode
- This means:
  - ✅ Your Node.js bot can access data (using direct connection string)
  - ❌ No one can access data via Supabase API/public endpoints
  - 🔒 Maximum security for your data

### Schema Compatibility
The code expects these column names in the `tiers` table:
- `first_prize` (INT)
- `second_prize` (INT)  
- `third_prize` (INT)

Your original schema had:
- `p1_prize`, `p2_prize`, `p3_prize`

The migration file handles this by:
1. Adding the new columns
2. Copying data from old columns to new columns
3. Converting p3_prize (TEXT) to third_prize (INT) when possible

### Verification
After running the SQL, verify with:
```sql
SELECT COUNT(*) FROM payment_requests; -- Should be 0 initially
SELECT COUNT(*) FROM tiers; -- Should be 3
SELECT COUNT(*) FROM tickets WHERE tier_id = 1; -- Should be 100
```

### Admin Dashboard
Once the `payment_requests` table exists, the admin dashboard at `/admin.html` will work automatically.
