-- Winners Verification Table
-- Stores winner verification data and payout status

CREATE TABLE IF NOT EXISTS winners_verification (
    id SERIAL PRIMARY KEY,
    tier_id INT NOT NULL,
    round_no INT NOT NULL,
    ticket_number INT NOT NULL,
    user_id BIGINT NOT NULL,
    place INT NOT NULL, -- 1, 2, or 3
    full_name VARCHAR(255),
    payment_method VARCHAR(50), -- Telebirr or Cbebirr
    account_number VARCHAR(100),
    status VARCHAR(50) DEFAULT 'pending', -- pending, verification_submitted, paid, rejected
    verified_at TIMESTAMP,
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tier_id, round_no, ticket_number)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_winners_verification_status ON winners_verification(status);
CREATE INDEX IF NOT EXISTS idx_winners_verification_user ON winners_verification(user_id);
CREATE INDEX IF NOT EXISTS idx_winners_verification_tier_round ON winners_verification(tier_id, round_no);

-- Enable RLS
ALTER TABLE winners_verification ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE winners_verification IS 'Stores winner verification data and payout tracking';
COMMENT ON COLUMN winners_verification.status IS 'Status: pending, verification_submitted, paid, rejected';
