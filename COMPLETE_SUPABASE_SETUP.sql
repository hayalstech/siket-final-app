-- ============================================
-- COMPLETE SUPABASE DATABASE SETUP FOR SIKET LOTTO
-- Updated for 2026 TMA Standards & Enhanced Security
-- Copy and paste this entire file into Supabase SQL Editor
-- ============================================

-- 1. CLEANUP OLD STRUCTURE (if exists)
DROP TABLE IF EXISTS winners_verification;
DROP TABLE IF EXISTS payment_requests;
DROP TABLE IF EXISTS winners_history;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS tiers;
DROP TABLE IF EXISTS game_rounds;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS draw_seeds;
DROP TABLE IF EXISTS ticket_transactions;
DROP TABLE IF EXISTS user_stats;

-- 2. ROUNDS TRACKER (Gold, Silver, Bronze)
CREATE TABLE game_rounds (
    tier_id INT PRIMARY KEY,
    current_round INT DEFAULT 1,
    last_draw_time TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO game_rounds (tier_id, current_round) VALUES (1, 1), (2, 1), (3, 1);

-- 3. USERS TABLE (Enhanced for TMA integration)
CREATE TABLE users (
    user_id BIGINT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    telegram_username TEXT,
    language_code TEXT DEFAULT 'am',
    is_active BOOLEAN DEFAULT true,
    last_seen TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 4. TIERS TABLE (Enhanced with new features)
CREATE TABLE tiers (
    id SERIAL PRIMARY KEY,
    name_am TEXT NOT NULL,
    name_en TEXT NOT NULL,
    price INT NOT NULL,
    first_prize INT NOT NULL,
    second_prize INT NOT NULL,
    third_prize INT NOT NULL,
    p1_prize INT,      -- Legacy compatibility
    p2_prize INT,      -- Legacy compatibility
    p3_prize TEXT,     -- Legacy compatibility (can be text)
    color TEXT DEFAULT '#D4AF37', -- Theme color
    emoji TEXT DEFAULT '🎟️',
    description_am TEXT,
    description_en TEXT,
    max_tickets INT DEFAULT 100,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Insert enhanced tier data
INSERT INTO tiers (id, name_am, name_en, price, first_prize, second_prize, third_prize, p1_prize, p2_prize, p3_prize, color, emoji, description_am, description_en) VALUES 
(1, 'ነሐስ', 'Bronze', 100, 5000, 2000, 500, 5000, 2000, '2 Free Tickets', '#CD7F32', '🥉', 'የነሐስ ዙር - በጣም ተወዳጅ', 'Bronze Round - Most Affordable'),
(2, 'ብር', 'Silver', 300, 15000, 4000, 2000, 15000, 4000, '2000', '#C0C0C0', '🥈', 'የብር ዙር - መልካም ሽልማት', 'Silver Round - Great Prizes'),
(3, 'ወርቅ', 'Gold', 500, 30000, 7000, 3000, 30000, 7000, '3000', '#FFD700', '🥇', 'የወርቅ ዙር - ትልቅ ሽልማት', 'Gold Round - Biggest Prizes');

-- 5. TICKETS TABLE (Enhanced with audit trail)
CREATE TABLE tickets (
    id SERIAL PRIMARY KEY,
    tier_id INT REFERENCES tiers(id),
    round_no INT,
    number_val INT NOT NULL, 
    status TEXT DEFAULT 'available' CHECK (status IN ('available', 'pending', 'sold', 'reserved')),
    owner_id BIGINT REFERENCES users(user_id),
    owner_name TEXT,
    payment_phone TEXT,
    screenshot_url TEXT,
    transaction_hash TEXT, -- For audit trail
    purchase_timestamp TIMESTAMP,
    approved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tier_id, round_no, number_val)
);

-- 6. WINNERS HISTORY (Enhanced with more data)
CREATE TABLE winners_history (
    id SERIAL PRIMARY KEY,
    tier_id INT REFERENCES tiers(id),
    round_no INT,
    w1_num INT,
    w2_num INT,
    w3_num INT,
    w1_user_id BIGINT REFERENCES users(user_id),
    w2_user_id BIGINT REFERENCES users(user_id),
    w3_user_id BIGINT REFERENCES users(user_id),
    total_tickets_sold INT DEFAULT 0,
    draw_timestamp TIMESTAMP DEFAULT NOW(),
    server_seed_hash TEXT,
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 7. PAYMENT REQUESTS TABLE (Enhanced with security)
CREATE TABLE payment_requests (
    id SERIAL PRIMARY KEY,
    tier_id INT NOT NULL,
    ticket_number INT NOT NULL,
    round_no INT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(user_id),
    full_name VARCHAR(255),
    phone VARCHAR(50),
    screenshot_url TEXT,
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    admin_id BIGINT, -- Admin who approved/rejected
    admin_notes TEXT,
    processed_at TIMESTAMP,
    ip_address TEXT, -- For security
    user_agent TEXT, -- For security
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for payment_requests
CREATE INDEX idx_payment_requests_status ON payment_requests(status);
CREATE INDEX idx_payment_requests_tier_round ON payment_requests(tier_id, round_no);
CREATE INDEX idx_payment_requests_start_time ON payment_requests(start_time DESC);

-- 8. WINNERS VERIFICATION TABLE (Enhanced)
CREATE TABLE winners_verification (
    id SERIAL PRIMARY KEY,
    tier_id INT NOT NULL REFERENCES tiers(id),
    round_no INT NOT NULL,
    ticket_number INT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(user_id),
    place INT NOT NULL CHECK (place IN (1, 2, 3)),
    full_name VARCHAR(255),
    payment_method VARCHAR(50) CHECK (payment_method IN ('Telebirr', 'Cbebirr', 'Awash', 'Dashen', 'Bank')),
    account_number VARCHAR(100),
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'verification_submitted', 'paid', 'rejected', 'expired')),
    verified_at TIMESTAMP,
    paid_at TIMESTAMP,
    admin_id BIGINT, -- Admin who processed
    admin_notes TEXT,
    transaction_reference TEXT, -- Payment reference
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
    UNIQUE(tier_id, round_no, ticket_number)
);

-- Create indexes for winners_verification
CREATE INDEX idx_winners_verification_status ON winners_verification(status);
CREATE INDEX idx_winners_verification_user ON winners_verification(user_id);
CREATE INDEX idx_winners_verification_tier_round ON winners_verification(tier_id, round_no);

-- 9. DRAW SEEDS TABLE (For provably fair system)
CREATE TABLE draw_seeds (
    id SERIAL PRIMARY KEY,
    tier_id INT NOT NULL,
    round_no INT NOT NULL,
    server_seed_hash TEXT NOT NULL,
    server_seed TEXT NOT NULL, -- Revealed after draw
    client_seed TEXT, -- Future feature
    combined_seed TEXT NOT NULL,
    draw_hash TEXT NOT NULL,
    is_revealed BOOLEAN DEFAULT false,
    revealed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(tier_id, round_no)
);

-- 10. TICKET TRANSACTIONS TABLE (Enhanced audit trail)
CREATE TABLE ticket_transactions (
    id SERIAL PRIMARY KEY,
    tier_id INT NOT NULL,
    round_no INT NOT NULL,
    ticket_number INT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(user_id),
    transaction_hash TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sold', 'failed')),
    amount INT NOT NULL,
    payment_method TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 11. USER STATS VIEW (For dashboard)
CREATE VIEW user_stats AS
SELECT 
    u.user_id,
    u.username,
    u.first_name,
    u.last_name,
    COUNT(t.id) as total_tickets,
    COUNT(CASE WHEN t.status = 'sold' THEN 1 END) as sold_tickets,
    COUNT(CASE WHEN t.status = 'pending' THEN 1 END) as pending_tickets,
    COUNT(wv.id) as total_wins,
    COALESCE(SUM(CASE WHEN wv.place = 1 THEN tiers.first_prize 
                     WHEN wv.place = 2 THEN tiers.second_prize 
                     WHEN wv.place = 3 THEN tiers.third_prize END), 0) as total_winnings,
    MAX(t.created_at) as last_activity
FROM users u
LEFT JOIN tickets t ON u.user_id = t.owner_id
LEFT JOIN winners_verification wv ON u.user_id = wv.user_id
LEFT JOIN tiers ON wv.tier_id = tiers.id
GROUP BY u.user_id, u.username, u.first_name, u.last_name;

-- 12. SEED INITIAL TICKETS (Round 1)
DO $$ BEGIN
    FOR t_id IN 1..3 LOOP
        FOR n IN 1..100 LOOP
            INSERT INTO tickets (tier_id, number_val, round_no) VALUES (t_id, n, 1);
        END LOOP;
    END LOOP;
END $$;

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

-- Tickets indexes
CREATE INDEX idx_tickets_tier_round_status ON tickets(tier_id, round_no, status);
CREATE INDEX idx_tickets_owner_id ON tickets(owner_id);
CREATE INDEX idx_tickets_transaction_hash ON tickets(transaction_hash);

-- Draw seeds indexes
CREATE INDEX idx_draw_seeds_tier_round ON draw_seeds(tier_id, round_no);

-- Ticket transactions indexes
CREATE INDEX idx_ticket_transactions_user ON ticket_transactions(user_id);
CREATE INDEX idx_ticket_transactions_hash ON ticket_transactions(transaction_hash);
CREATE INDEX idx_ticket_transactions_tier_round ON ticket_transactions(tier_id, round_no);

-- Winners history indexes
CREATE INDEX idx_winners_history_tier_round ON winners_history(tier_id, round_no);
CREATE INDEX idx_winners_history_draw_time ON winners_history(draw_timestamp DESC);

-- ============================================
-- TRIGGERS FOR AUTOMATIC UPDATES
-- ============================================

-- Update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers to tables with updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tickets_updated_at BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payment_requests_updated_at BEFORE UPDATE ON payment_requests
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_winners_verification_updated_at BEFORE UPDATE ON winners_verification
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_game_rounds_updated_at BEFORE UPDATE ON game_rounds
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

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
ALTER TABLE winners_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE draw_seeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_transactions ENABLE ROW LEVEL SECURITY;

-- IMPORTANT: No policies are created, which means:
-- - NO ONE can access data via Supabase API/public endpoints
-- - Only your Node.js bot (using direct connection string) can access data
-- - This is the "Lockdown" approach for maximum security

-- ============================================
-- VERIFICATION QUERIES (Optional - run to verify)
-- ============================================
-- SELECT COUNT(*) FROM tickets WHERE tier_id = 1; -- Should return 100
-- SELECT COUNT(*) FROM tiers; -- Should return 3
-- SELECT COUNT(*) FROM game_rounds; -- Should return 3
-- SELECT COUNT(*) FROM payment_requests; -- Should return 0 initially
-- SELECT COUNT(*) FROM winners_verification; -- Should return 0 initially
-- SELECT COUNT(*) FROM draw_seeds; -- Should return 0 initially
-- SELECT COUNT(*) FROM ticket_transactions; -- Should return 0 initially
-- SELECT * FROM user_stats LIMIT 5; -- Should show user statistics

-- ============================================
-- MIGRATION NOTES
-- ============================================
-- This setup includes:
-- 1. Enhanced security with RLS (no public access)
-- 2. Provably fair lottery system with draw_seeds
-- 3. Comprehensive audit trail with transaction hashes
-- 4. User statistics dashboard view
-- 5. Enhanced payment and verification systems
-- 6. Automatic timestamp updates
-- 7. Performance optimization with proper indexes
-- 8. Data integrity with CHECK constraints
-- 9. Foreign key relationships for consistency
-- 10. Support for 2026 TMA standards

-- ============================================
-- END OF SETUP
-- ============================================
