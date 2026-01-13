-- Migration: Create payment_requests table for Admin Dashboard
-- This table stores payment requests permanently for admin review

CREATE TABLE IF NOT EXISTS payment_requests (
    id SERIAL PRIMARY KEY,
    tier_id INTEGER NOT NULL,
    ticket_number INTEGER NOT NULL,
    round_no INTEGER NOT NULL,
    user_id BIGINT NOT NULL,
    full_name VARCHAR(255),
    phone VARCHAR(50),
    screenshot_url TEXT,
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_tier_round ON payment_requests(tier_id, round_no);
CREATE INDEX IF NOT EXISTS idx_payment_requests_start_time ON payment_requests(start_time DESC);

-- Add comments
COMMENT ON TABLE payment_requests IS 'Stores all payment requests permanently for admin dashboard';
COMMENT ON COLUMN payment_requests.status IS 'Status: pending, approved, rejected';
