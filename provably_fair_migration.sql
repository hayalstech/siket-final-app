-- ============================================
-- PROVABLY FAIR & TRANSPARENCY MIGRATION
-- Run this after your existing tables are set up
-- ============================================

-- 1. DRAW SEEDS TABLE (For Provably Fair)
CREATE TABLE IF NOT EXISTS draw_seeds (
    id SERIAL PRIMARY KEY,
    tier_id INT NOT NULL,
    round_no INT NOT NULL,
    server_seed_hash TEXT NOT NULL, -- SHA256 hash of server seed (published BEFORE draw)
    server_seed TEXT, -- Revealed AFTER draw for verification
    client_seed TEXT, -- Optional: user-provided seed
    combined_seed TEXT, -- server_seed + client_seed (for verification)
    draw_hash TEXT, -- Final hash used for draw
    created_at TIMESTAMP DEFAULT NOW(),
    revealed_at TIMESTAMP, -- When seeds were revealed
    UNIQUE(tier_id, round_no)
);

CREATE INDEX idx_draw_seeds_tier_round ON draw_seeds(tier_id, round_no);

-- 2. TICKET TRANSACTIONS TABLE (For Audit Log)
CREATE TABLE IF NOT EXISTS ticket_transactions (
    id SERIAL PRIMARY KEY,
    tier_id INT NOT NULL,
    round_no INT NOT NULL,
    ticket_number INT NOT NULL,
    user_id BIGINT NOT NULL,
    transaction_hash TEXT NOT NULL, -- SHA256(tier_id + round_no + ticket_number + user_id + timestamp)
    status TEXT DEFAULT 'sold', -- sold, pending, rejected
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tier_id, round_no, ticket_number)
);

CREATE INDEX idx_transactions_tier_round ON ticket_transactions(tier_id, round_no);
CREATE INDEX idx_transactions_user ON ticket_transactions(user_id);
CREATE INDEX idx_transactions_hash ON ticket_transactions(transaction_hash);

-- 3. USER STATISTICS VIEW (For Dashboard)
CREATE OR REPLACE VIEW user_stats AS
SELECT 
    t.owner_id as user_id,
    COUNT(CASE WHEN t.status = 'sold' THEN 1 END) as total_tickets_bought,
    COUNT(CASE WHEN t.status = 'pending' THEN 1 END) as pending_tickets,
    SUM(CASE WHEN t.status = 'sold' THEN ti.price ELSE 0 END) as total_spent,
    COUNT(CASE WHEN wv.status = 'paid' THEN 1 END) as total_wins,
    SUM(CASE 
        WHEN wv.status = 'paid' AND wv.place = 1 THEN ti.first_prize
        WHEN wv.status = 'paid' AND wv.place = 2 THEN ti.second_prize
        WHEN wv.status = 'paid' AND wv.place = 3 THEN ti.third_prize
        ELSE 0
    END) as total_won
FROM tickets t
LEFT JOIN tiers ti ON t.tier_id = ti.id
LEFT JOIN winners_verification wv ON t.tier_id = wv.tier_id 
    AND t.round_no = wv.round_no 
    AND t.number_val = wv.ticket_number
    AND t.owner_id = wv.user_id
GROUP BY t.owner_id;

-- 4. Add transaction_hash column to tickets table if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'tickets' AND column_name = 'transaction_hash'
    ) THEN
        ALTER TABLE tickets ADD COLUMN transaction_hash TEXT;
        CREATE INDEX idx_tickets_transaction_hash ON tickets(transaction_hash);
    END IF;
END $$;

-- 5. Add purchase_timestamp to tickets for better audit trail
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'tickets' AND column_name = 'purchase_timestamp'
    ) THEN
        ALTER TABLE tickets ADD COLUMN purchase_timestamp TIMESTAMP DEFAULT NOW();
        CREATE INDEX idx_tickets_purchase_time ON tickets(purchase_timestamp DESC);
    END IF;
END $$;
