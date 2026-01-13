-- ============================================
-- ADD PAYMENT_REQUESTS TABLE TO EXISTING SCHEMA
-- Use this if you've already run your original schema
-- ============================================

-- 1. CREATE PAYMENT_REQUESTS TABLE
CREATE TABLE IF NOT EXISTS payment_requests (
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

-- 2. CREATE INDEXES FOR PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_tier_round ON payment_requests(tier_id, round_no);
CREATE INDEX IF NOT EXISTS idx_payment_requests_start_time ON payment_requests(start_time DESC);

-- 3. ADD MISSING COLUMNS TO TIERS TABLE (for code compatibility)
-- The code expects first_prize, second_prize, third_prize
ALTER TABLE tiers 
ADD COLUMN IF NOT EXISTS first_prize INT,
ADD COLUMN IF NOT EXISTS second_prize INT,
ADD COLUMN IF NOT EXISTS third_prize INT;

-- 4. POPULATE NEW COLUMNS FROM EXISTING DATA
-- Map p1_prize -> first_prize, p2_prize -> second_prize
-- For p3_prize, try to convert to INT (if it's a number) or use 0
UPDATE tiers SET 
    first_prize = COALESCE(p1_prize, 0),
    second_prize = COALESCE(p2_prize, 0),
    third_prize = CASE 
        WHEN p3_prize ~ '^[0-9]+$' THEN p3_prize::INT 
        ELSE 0 
    END
WHERE first_prize IS NULL;

-- 5. ENABLE RLS ON PAYMENT_REQUESTS
ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;

-- No policies = Lockdown mode (only Node.js bot can access)
