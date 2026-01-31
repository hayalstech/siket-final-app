-- Migration: Add integer-cent columns for monetary values and backfill from existing numeric EUR/ETB
BEGIN;

-- Add cents columns
ALTER TABLE IF EXISTS user_wallets ADD COLUMN IF NOT EXISTS balance_cents BIGINT DEFAULT 0;
ALTER TABLE IF EXISTS transaction_registry ADD COLUMN IF NOT EXISTS amount_cents BIGINT;

-- Backfill balance_cents from balance_eur if present
-- This sets balance_cents = ROUND(balance_eur * 100)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_wallets' AND column_name='balance_eur') THEN
        UPDATE user_wallets SET balance_cents = ROUND(COALESCE(balance_eur,0) * 100)::BIGINT;
    END IF;
END$$;

-- Backfill amount_cents from amount_eur in transaction_registry
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='transaction_registry' AND column_name='amount_eur') THEN
        UPDATE transaction_registry SET amount_cents = ROUND(COALESCE(amount_eur,0) * 100)::BIGINT WHERE amount_cents IS NULL;
    END IF;
END$$;

COMMIT;

-- Note: After running this migration, update application code to exclusively use balance_cents/amount_cents.
