-- ============================================
-- SUPABASE DATABASE SETUP FOR SIKET LOTTO
-- ============================================

-- 1. CLEANUP OLD STRUCTURE
DROP TABLE IF EXISTS payment_requests;
DROP TABLE IF EXISTS winners_history;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS tiers;
DROP TABLE IF EXISTS game_rounds;
DROP TABLE IF EXISTS users;

-- 2. ROUNDS TRACKER (Gold, Silver, Bronze)
CREATE TABLE game_rounds (
    tier_id INT PRIMARY KEY,
    current_round INT DEFAULT 1
);
INSERT INTO game_rounds (tier_id, current_round) VALUES (1, 1), (2, 1), (3, 1);

-- 3. USERS TABLE
CREATE TABLE users (
    user_id BIGINT PRIMARY KEY,
    username TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 4. TIERS TABLE (Prices and Prizes)
-- Updated to match code expectations: first_prize, second_prize, third_prize
CREATE TABLE tiers (
    id SERIAL PRIMARY KEY,
    name_am TEXT,
    name_en TEXT,
    price INT,
    first_prize INT,  -- Changed from p1_prize
    second_prize INT, -- Changed from p2_prize
    third_prize INT,  -- Changed from p3_prize (now numeric)
    p1_prize INT,      -- Keep for backward compatibility
    p2_prize INT,
    p3_prize TEXT      -- Keep original for reference
);

-- Insert tier data with both old and new column names
INSERT INTO tiers (id, name_am, name_en, price, first_prize, second_prize, third_prize, p1_prize, p2_prize, p3_prize) VALUES 
(1, 'ነሐስ', 'Bronze', 100, 5000, 2000, 0, 5000, 2000, '2 Free Tickets'),
(2, 'ብር', 'Silver', 300, 15000, 4000, 2000, 15000, 4000, '2000'),
(3, 'ወርቅ', 'Gold', 500, 30000, 7000, 3000, 30000, 7000, '3000');

-- 5. TICKETS TABLE (The 1-100 grid per Round)
CREATE TABLE tickets (
    id SERIAL PRIMARY KEY,
    tier_id INT REFERENCES tiers(id),
    round_no INT,
    number_val INT NOT NULL, 
    status TEXT DEFAULT 'available', -- available, pending, sold
    owner_id BIGINT,
    owner_name TEXT,
    payment_phone TEXT,
    screenshot_url TEXT,
    UNIQUE(tier_id, round_no, number_val)
);

-- 6. WINNERS HISTORY (For the Last 10 Rounds UI)
CREATE TABLE winners_history (
    id SERIAL PRIMARY KEY,
    tier_id INT REFERENCES tiers(id),
    round_no INT,
    w1_num INT,
    w2_num INT,
    w3_num INT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 7. PAYMENT REQUESTS TABLE (For Admin Dashboard)
CREATE TABLE payment_requests (
    id SERIAL PRIMARY KEY,
    tier_id INT NOT NULL,
    ticket_number INT NOT NULL,
    round_no INT NOT NULL,
    user_id BIGINT NOT NULL,
    full_name VARCHAR(255),
    phone VARCHAR(50),
    screenshot_url TEXT,
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for payment_requests
CREATE INDEX idx_payment_requests_status ON payment_requests(status);
CREATE INDEX idx_payment_requests_tier_round ON payment_requests(tier_id, round_no);
CREATE INDEX idx_payment_requests_start_time ON payment_requests(start_time DESC);

-- 8. SEED INITIAL TICKETS (Round 1)
DO $$ BEGIN
    FOR t_id IN 1..3 LOOP
        FOR n IN 1..100 LOOP
            INSERT INTO tickets (tier_id, number_val, round_no) VALUES (t_id, n, 1);
        END LOOP;
    END LOOP;
END $$;

-- ============================================
-- ROW LEVEL SECURITY (RLS) SETUP
-- ============================================
-- Enable RLS for all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE winners_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;

-- IMPORTANT: No policies are created, which means:
-- - NO ONE can access data via Supabase API/public endpoints
-- - Only your Node.js bot (using direct connection string) can access data
-- - This is the "Lockdown" approach for security

-- ============================================
-- VERIFICATION QUERIES (Optional - run to verify)
-- ============================================
-- SELECT COUNT(*) FROM tickets WHERE tier_id = 1; -- Should return 100
-- SELECT COUNT(*) FROM tiers; -- Should return 3
-- SELECT COUNT(*) FROM game_rounds; -- Should return 3
