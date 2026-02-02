require('dotenv').config();
const { Bot, InlineKeyboard, InputFile, webhookCallback } = require('grammy');
const { pool, getUser } = require('./database');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const bot = new Bot(process.env.BOT_TOKEN);
const app = express();
const upload = multer({ dest: 'uploads/' });
const pendingProofs = new Map();
// Buffers for grouping rapid purchase events to avoid spam
const purchaseAlertBuffers = new Map(); // tierId -> {count, timer}

// Redis/Upstash client (lazy-init). If REDIS_URL is provided, we'll try to use it
let redisClient = null;
async function getRedis() {
    if (redisClient) return redisClient;
    if (!process.env.REDIS_URL) return null;
    try {
        const { createClient } = require('redis');
        redisClient = createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (e) => console.warn('Redis client error', e));
        await redisClient.connect();
        console.log('✅ Connected to Redis');
        return redisClient;
    } catch (e) {
        console.warn('Redis not available:', e.message || e);
        redisClient = null;
        return null;
    }
}

// Bot identity cache (will be initialized async)
let BOT_USERNAME = process.env.BOT_USERNAME || null;
async function initBotIdentity() {
    try {
        const me = await bot.api.getMe();
        BOT_USERNAME = me.username || process.env.BOT_USERNAME || null;
        console.log('✅ Bot identity:', BOT_USERNAME);
    } catch (e) {
        console.error('Error fetching bot identity:', e);
    }
}
initBotIdentity().catch(e => console.error(e));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Currency conversion constant (1 EUR = 200 ETB)
const EUR_TO_ETB = parseFloat(process.env.EUR_TO_ETB || '200');

// Ensure deposit-related tables exist (idempotent)
async function ensureDepositTables() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS deposit_requests (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                payment_method TEXT,
                account_number TEXT,
                amount_etb NUMERIC,
                transaction_reference TEXT,
                notes TEXT,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW(),
                validity_expires TIMESTAMP,
                admin_id BIGINT,
                processed_at TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS transaction_registry (
                id SERIAL PRIMARY KEY,
                tx_reference TEXT UNIQUE,
                user_id BIGINT,
                amount_etb NUMERIC,
                amount_eur NUMERIC,
                admin_id BIGINT,
                created_at TIMESTAMP DEFAULT NOW(),
                processed_at TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_wallets (
                user_id BIGINT PRIMARY KEY,
                balance_eur NUMERIC DEFAULT 0
            )
        `);

        console.log('✅ Deposit-related tables ensured');
    } catch (e) {
        console.error('Error ensuring deposit tables:', e);
    }
}

// Call once at startup (no await to avoid blocking server start)
ensureDepositTables().catch(e => console.error(e));

// Ensure draw_seeds table exists for provably-fair flow
async function ensureDrawSeedsTable() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS draw_seeds (
                id SERIAL PRIMARY KEY,
                tier_id INT NOT NULL,
                round_no INT NOT NULL,
                server_seed TEXT,
                server_seed_hash TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('✅ draw_seeds table ensured');
    } catch (e) { console.error('Error ensuring draw_seeds', e); }
}
ensureDrawSeedsTable().catch(e => console.error(e));

// Handle tier sold-out -> lockdown, publish draw seed, and schedule draw
async function handleTierSoldFull(tierId) {
    try {
        const client = await getRedis();
        const lockKey = `tier_lockdown:${tierId}`;
        if (client) {
            const exists = await client.get(lockKey);
            if (exists) return; // already handled
            await client.set(lockKey, '1', { EX: 230 }); // ~3m50s guard
            const startKey = `tier_lockdown_start:${tierId}`;
            const startTs = Date.now();
            await client.set(startKey, String(startTs), { EX: 230 });
        }

        // Determine current round
        const rres = await pool.query('SELECT current_round FROM game_rounds WHERE tier_id = $1', [tierId]);
        const round = rres.rows[0]?.current_round || 1;

        // Create server seed and hash
        const server_seed = crypto.randomBytes(32).toString('hex');
        const server_seed_hash = crypto.createHash('sha256').update(server_seed).digest('hex');
        await pool.query('INSERT INTO draw_seeds (tier_id, round_no, server_seed, server_seed_hash) VALUES ($1,$2,$3,$4)', [tierId, round, server_seed, server_seed_hash]);

        const links = buildWebappLinks();
        const arenaUrl = `${links.web.replace(/\/$/, '')}/draw.html?tier=${tierId}&round=${round}`;

        const groupId = process.env.WINNERS_GROUP_ID || '@siketlotto';
        await bot.api.sendMessage(groupId, `🔒 Pool Full! The ${tierId==3?'Gold':tierId==2?'Silver':'Bronze'} grid is full. Enter the 4K Cinematic Draw Arena: ${arenaUrl}`);
        await bot.api.sendMessage(groupId, `⏳ The draw will start in 3 minutes. Join the live arena now!`);

        // Schedule the draw after 3 minutes (180s)
        setTimeout(async () => {
            try {
                // pick random sold ticket as winner
                const ticketsRes = await pool.query("SELECT id, number_val, owner_id FROM tickets WHERE tier_id = $1 AND round_no = $2 AND status = 'sold'", [tierId, round]);
                const rows = ticketsRes.rows || [];
                if (rows.length === 0) {
                    await bot.api.sendMessage(groupId, `⚠️ Draw could not complete: no sold tickets found.`);
                } else {
                    const winner = rows[Math.floor(Math.random()*rows.length)];
                    // announce winner
                    const winnerText = `🏅 1st Place Winner: ${winner.owner_id ? `User#${winner.owner_id}` : 'Anonymous'} — Ticket #${winner.number_val} — Prize: ${(tierId==3?2.5: tierId==2?1.5:0.5) * 80} EUR`;
                    await bot.api.sendMessage(groupId, winnerText);
                    await bot.api.sendMessage(groupId, `🎉 New Round Now Open — grab your tickets!`);
                }
                    // clear lockdown
                    if (client) {
                        await client.del(lockKey);
                        const startKey = `tier_lockdown_start:${tierId}`;
                        await client.del(startKey);
                    }
            } catch (e) {
                console.error('Error running scheduled draw', e);
            }
        }, 180000);

    } catch (e) {
        console.error('handleTierSoldFull error', e);
    }
}

// Secret to protect cron endpoints
const CRON_SECRET = process.env.CRON_SECRET || 'please-set-a-secret';

function buildWebappLinks() {
    const web = (process.env.WEBAPP_URL || '').replace(/\/$/, '');
    const botLink = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}/app` : `https://t.me/${process.env.BOT_USERNAME || 'your_bot'}/app`;
    return { web, botLink };
}

async function postPurchaseAlertNow(tierId, addedCount = 0) {
    try {
        // compute sold and remaining
        const soldRes = await pool.query("SELECT count(*) as count FROM tickets WHERE tier_id = $1 AND status = 'sold'", [tierId]);
        const sold = parseInt(soldRes.rows[0].count || 0);
        const remaining = Math.max(0, 100 - sold);
        const tierName = tierId == 3 ? 'Gold' : tierId == 2 ? 'Silver' : 'Bronze';
        const plural = addedCount > 1 ? `${addedCount} blocks` : 'a block';
        const links = buildWebappLinks();
        const text = `🎟️ New Entry! ${plural} just grabbed in the ${tierName} Grid! ${remaining}/100 blocks remaining before the computerized draw begins!\n\nJoin: ${links.web} or ${links.botLink}`;
        const groupId = process.env.WINNERS_GROUP_ID || '@siketlotto';
        await bot.api.sendMessage(groupId, text);
        // If this sale closed the pool, initiate lockdown/draw flow
        if (sold === 100) {
            try { await handleTierSoldFull(tierId); } catch (e) { console.error('handleTierSoldFull failed', e); }
        }
    } catch (e) {
        console.error('Error posting purchase alert:', e);
    }
}

async function schedulePurchaseAlert(tierId, addedCount = 1, debounceMs = 1200) {
    // Try Redis-backed aggregation first (safer across multiple instances)
    try {
        const client = await getRedis();
        if (client) {
            const key = `purchase_buffer:${tierId}`;
            const lockKey = `purchase_lock:${tierId}`;
            await client.incrBy(key, addedCount);
            await client.expire(key, Math.ceil((debounceMs + 500) / 1000) + 10);
            // Try to obtain a short-lived lock. Only the locker will schedule the post.
            const got = await client.set(lockKey, '1', { NX: true, PX: debounceMs });
            if (got) {
                setTimeout(async () => {
                    try {
                        const cnt = parseInt(await client.get(key) || '0', 10);
                        await client.del(key);
                        await client.del(lockKey);
                        if (cnt > 0) await postPurchaseAlertNow(tierId, cnt);
                    } catch (e) { console.error('Redis-schedule error', e); }
                }, debounceMs + 50);
            }
            return;
        }
    } catch (e) {
        console.warn('schedulePurchaseAlert(redis) failed', e);
    }

    // Fallback: in-memory debounce (single-instance)
    const key = String(tierId);
    const existing = purchaseAlertBuffers.get(key) || { count: 0, timer: null };
    existing.count += addedCount;
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
        postPurchaseAlertNow(tierId, existing.count).catch(e => console.error(e));
        purchaseAlertBuffers.delete(key);
    }, debounceMs);
    purchaseAlertBuffers.set(key, existing);
}

// Explicitly serve index.html for root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- API: Return sold blocks for a tier (array of indices 0..99) ---
app.get('/api/sold-blocks', async (req, res) => {
    try {
        const tier = parseInt(req.query.tier || req.params.tier || '3', 10);

        // Determine current round from DB (if available)
        const roundRes = await pool.query('SELECT current_round FROM game_rounds WHERE tier_id = $1', [tier]);
        const round = roundRes.rows[0] ? roundRes.rows[0].current_round : null;

        // Prepare a default 100-entry map
        const result = Array.from({ length: 100 }, (_, i) => ({ index: i, status: 'available' }));

        // Try Redis first for reservation info (more real-time)
        try {
            const client = await getRedis();
            if (client) {
                const pattern = `ticket_sold:${tier}:${round}:*`;
                const keys = await client.keys(pattern);
                // Mark reserved entries
                for (const k of keys || []) {
                    const parts = k.split(':');
                    const idx = parseInt(parts[3], 10);
                    if (Number.isNaN(idx) || idx < 0 || idx >= 100) continue;
                    const owner = await client.get(k);
                    const ttl = await client.ttl(k);
                    result[idx] = { index: idx, status: 'reserved', owner: owner || null, expiresIn: ttl >= 0 ? ttl : null };
                }

                // Also overlay committed 'sold' tickets from DB, if possible
                if (round) {
                    const tickets = await pool.query('SELECT number_val, owner_id FROM tickets WHERE tier_id = $1 AND round_no = $2 AND status = $3', [tier, round, 'sold']);
                    for (const r of tickets.rows || []) {
                        const n = parseInt(r.number_val, 10) - 1;
                        if (Number.isNaN(n) || n < 0 || n >= 100) continue;
                        result[n] = { index: n, status: 'sold', owner: r.owner_id || null };
                    }
                }

                return res.json({ tier, round, tickets: result });
            }
        } catch (e) {
            console.warn('/api/sold-blocks: Redis read failed, falling back to DB', e && e.message ? e.message : e);
        }

        // Fallback: query DB for sold tickets in current round
        if (!round) return res.json({ tier, round: null, tickets: result });
        const dbTickets = await pool.query('SELECT number_val, owner_id FROM tickets WHERE tier_id = $1 AND round_no = $2 AND status = $3', [tier, round, 'sold']);
        for (const r of dbTickets.rows || []) {
            const n = parseInt(r.number_val, 10) - 1;
            if (Number.isNaN(n) || n < 0 || n >= 100) continue;
            result[n] = { index: n, status: 'sold', owner: r.owner_id || null };
        }
        return res.json({ tier, round, tickets: result });
    } catch (e) {
        console.error('Error in /api/sold-blocks:', e);
        return res.status(500).json({ error: 'server' });
    }
});

// Lockdown status endpoint for client checks
app.get('/api/lockdown/:tierId', async (req, res) => {
    try {
        const tierId = parseInt(req.params.tierId,10);
        const client = await getRedis();
        if (!client) return res.json({ lockdown: false });
        const key = `tier_lockdown:${tierId}`;
        const exists = await client.get(key);
        if (!exists) return res.json({ lockdown: false });
        const startKey = `tier_lockdown_start:${tierId}`;
        const startTs = parseInt(await client.get(startKey) || '0', 10);
        const now = Date.now();
        const elapsed = startTs ? Math.floor((now - startTs)/1000) : 0;
        const remaining = Math.max(0, 180 - elapsed);
        return res.json({ lockdown: true, startTs, elapsed, remaining });
    } catch (e) {
        return res.json({ lockdown: false });
    }
});

// Spectator connect/disconnect and count
app.post('/api/spectator/connect', async (req, res) => {
    try {
        const tier = parseInt(req.query.tier || req.body.tier || '3', 10);
        const client = await getRedis();
        if (!client) return res.json({ ok: true, count: 0 });
        const key = `spectator:${tier}`;
        const cnt = await client.incr(key);
        await client.expire(key, 60*10); // expire after 10m of inactivity
        return res.json({ ok: true, count: parseInt(cnt,10) });
    } catch (e) { console.error(e); return res.status(500).json({ ok:false }); }
});

app.post('/api/spectator/disconnect', async (req, res) => {
    try {
        const tier = parseInt(req.query.tier || req.body.tier || '3', 10);
        const client = await getRedis();
        if (!client) return res.json({ ok: true, count: 0 });
        const key = `spectator:${tier}`;
        const cnt = await client.decr(key);
        return res.json({ ok: true, count: Math.max(0, parseInt(cnt,10)) });
    } catch (e) { console.error(e); return res.status(500).json({ ok:false }); }
});

app.get('/api/spectator/count', async (req, res) => {
    try {
        const tier = parseInt(req.query.tier || '3', 10);
        const client = await getRedis();
        if (!client) return res.json({ count: 0 });
        const key = `spectator:${tier}`;
        const cnt = await client.get(key);
        return res.json({ count: parseInt(cnt||'0',10) });
    } catch (e) { console.error(e); return res.json({ count: 0 }); }
});

// Complete purchase endpoint: reserves tickets in Redis atomically and persists to DB
app.post('/api/complete-purchase', express.json(), async (req, res) => {
    try {
        const { userId, tierId, roundNo, numbers, tx_reference } = req.body || {};
        if (!userId || !tierId || !roundNo || !Array.isArray(numbers) || numbers.length===0) return res.status(400).json({ error: 'invalid' });
        // anti-fraud: check tx_reference
        if (tx_reference) {
            const dup = await pool.query('SELECT id FROM transaction_registry WHERE tx_reference = $1 LIMIT 1', [tx_reference]);
            if (dup.rows.length > 0) return res.status(409).json({ error: 'duplicate_tx' });
        }
        const client = await getRedis();
        if (!client) return res.status(500).json({ error: 'redis_required' });

        // Attempt to reserve all ticket numbers using SET NX
        const reserved = [];
        for (const n of numbers) {
            const key = `ticket_sold:${tierId}:${roundNo}:${n}`;
            const ok = await client.set(key, String(userId), { NX: true, EX: 60*60*2 });
            if (!ok) {
                // rollback reserved
                for (const r of reserved) await client.del(r);
                return res.status(409).json({ error: 'ticket_unavailable', number: n });
            }
            reserved.push(key);
        }

        // increment sold counter
        const soldKey = `tier_sold_count:${tierId}:${roundNo}`;
        const newCount = await client.incrBy(soldKey, numbers.length);
        await client.expire(soldKey, 60*60*4);

        // Announce fill-status every 10 tickets (e.g., 10/100, 20/100)
        try {
            const announceEvery = 10;
            if (parseInt(newCount, 10) % announceEvery === 0 && parseInt(newCount,10) < 100) {
                const links = buildWebappLinks();
                const tierName = tierId == 3 ? 'Gold' : tierId == 2 ? 'Silver' : 'Bronze';
                const groupId = process.env.WINNERS_GROUP_ID || '@siketlotto';
                await bot.api.sendMessage(groupId, `🔔 ${tierName} Pool Update: ${parseInt(newCount,10)}/100 blocks filled. Join now: ${links.web || links.botLink}`);
            }
        } catch (e) {
            console.warn('Fill-status announce failed', e);
        }

        // persist transaction registry
        if (tx_reference) {
            await pool.query('INSERT INTO transaction_registry (tx_reference, user_id, amount_etb, amount_eur, created_at) VALUES ($1,$2,$3,$4, NOW())', [tx_reference, userId, null, null]);
        }

        // Persist tickets to DB (best-effort)
        for (const n of numbers) {
            try {
                const upd = await pool.query("UPDATE tickets SET owner_id=$1, status='sold', purchase_timestamp=NOW() WHERE tier_id=$2 AND round_no=$3 AND number_val=$4 AND status != 'sold'", [userId, tierId, roundNo, n]);
                if (upd.rowCount === 0) {
                    try {
                        await pool.query('INSERT INTO tickets (tier_id, round_no, number_val, owner_id, status, purchase_timestamp) VALUES ($1,$2,$3,$4,\'sold\', NOW())', [tierId, roundNo, n, userId]);
                    } catch(e) { /* ignore duplicate */ }
                }
            } catch (e) { console.error('DB ticket persist error', e); }
        }

        // notify grouping
        schedulePurchaseAlert(tierId, numbers.length, 1200);

        // If pool is full, trigger lockdown handling
        if (parseInt(newCount,10) >= 100) {
            // ensure exactly 100
            try { await handleTierSoldFull(tierId); } catch(e){ console.error(e); }
        }

        return res.json({ ok: true, sold: parseInt(newCount,10) });
    } catch (e) {
        console.error('complete-purchase error', e);
        return res.status(500).json({ error: 'server' });
    }
});

// --- API: Get Tier Status & Tickets ---
app.get('/api/status/:tierId', async (req, res) => {
    try {
        const roundRes = await pool.query("SELECT current_round FROM game_rounds WHERE tier_id = $1", [req.params.tierId]);
        const round = roundRes.rows[0].current_round;
        const tierRes = await pool.query("SELECT * FROM tiers WHERE id = $1", [req.params.tierId]);
        const ticketsRes = await pool.query("SELECT number_val, status FROM tickets WHERE tier_id = $1 AND round_no = $2 ORDER BY number_val ASC", [req.params.tierId, round]);
        
        // Fetch last winner for animation trigger
        const lastWinner = await pool.query("SELECT w1_num as first, w2_num as second, w3_num as third FROM winners_history WHERE tier_id=$1 ORDER BY id DESC LIMIT 1", [req.params.tierId]);

        res.json({ 
            round, 
            prizes: tierRes.rows[0], 
            tickets: ticketsRes.rows,
            winners: lastWinner.rows[0] || { first: 0, second: 0, third: 0 }
        });
    } catch (err) { res.status(500).send(err.message); }
});

// --- API: Get History (Last 10) ---
app.get('/api/history/:tierId', async (req, res) => {
    try {
        const result = await pool.query("SELECT round_no, w1_num as first_num FROM winners_history WHERE tier_id = $1 ORDER BY id DESC LIMIT 10", [req.params.tierId]);
        res.json(result.rows);
    } catch (err) { res.status(500).send(err.message); }
});

// --- API: Get All Winners for Statistics ---
app.get('/api/winners/all', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT tier_id, round_no, w1_num as first, w2_num as second, w3_num as third, created_at
            FROM winners_history 
            ORDER BY id DESC 
            LIMIT 50
        `);
        res.json(result.rows);
    } catch (err) { 
        console.error('Error fetching all winners:', err);
        res.status(500).send(err.message); 
    }
});

// --- API: Get Statistics ---
app.get('/api/statistics', async (req, res) => {
    try {
        const totalWinners = await pool.query("SELECT COUNT(*) as count FROM winners_history");
        const totalRounds = await pool.query("SELECT COUNT(DISTINCT round_no) as count FROM winners_history");
        const todayWinners = await pool.query(`
            SELECT COUNT(*) as count FROM winners_history 
            WHERE DATE(created_at) = CURRENT_DATE
        `);
        
        res.json({
            totalWinners: parseInt(totalWinners.rows[0].count) || 0,
            totalRounds: parseInt(totalRounds.rows[0].count) || 0,
            todayWinners: parseInt(todayWinners.rows[0].count) || 0
        });
    } catch (err) {
        console.error('Error fetching statistics:', err);
        res.status(500).send(err.message);
    }
});

// --- API: Get User Dashboard Data ---
app.get('/api/user/dashboard', async (req, res) => {
    try {
        const userId = req.query.userId || req.headers['x-user-id'];
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }
        
        // Get user stats
        const statsRes = await pool.query(`
            SELECT * FROM user_stats WHERE user_id = $1
        `, [userId]);
        
        const stats = statsRes.rows[0] || {
            user_id: userId,
            total_tickets_bought: 0,
            pending_tickets: 0,
            total_spent: 0,
            total_wins: 0,
            total_won: 0
        };
        
        // Get active tickets (pending + sold)
        const activeTickets = await pool.query(`
            SELECT t.*, ti.name_en as tier_name, ti.name_am as tier_name_am, ti.price,
                   gr.current_round
            FROM tickets t
            JOIN tiers ti ON t.tier_id = ti.id
            JOIN game_rounds gr ON t.tier_id = gr.tier_id
            WHERE t.owner_id = $1 
            AND (t.status = 'pending' OR t.status = 'sold')
            AND t.round_no = gr.current_round
            ORDER BY t.purchase_timestamp DESC
        `, [userId]);
        
        // Get ticket history (past rounds)
        const historyTickets = await pool.query(`
            SELECT t.*, ti.name_en as tier_name, ti.name_am as tier_name_am, ti.price,
                   CASE 
                       WHEN wv.place = 1 THEN ti.first_prize
                       WHEN wv.place = 2 THEN ti.second_prize
                       WHEN wv.place = 3 THEN ti.third_prize
                       ELSE 0
                   END as prize_won,
                   wv.place as win_place,
                   wv.status as win_status
            FROM tickets t
            JOIN tiers ti ON t.tier_id = ti.id
            LEFT JOIN winners_verification wv ON t.tier_id = wv.tier_id 
                AND t.round_no = wv.round_no 
                AND t.number_val = wv.ticket_number
                AND t.owner_id = wv.user_id
            WHERE t.owner_id = $1 
            AND t.status = 'sold'
            AND t.round_no < (SELECT current_round FROM game_rounds WHERE tier_id = t.tier_id)
            ORDER BY t.purchase_timestamp DESC
            LIMIT 50
        `, [userId]);
        
        res.json({
            stats: {
                totalTicketsBought: parseInt(stats.total_tickets_bought) || 0,
                pendingTickets: parseInt(stats.pending_tickets) || 0,
                totalSpent: parseInt(stats.total_spent) || 0,
                totalWins: parseInt(stats.total_wins) || 0,
                totalWon: parseInt(stats.total_won) || 0
            },
            activeTickets: activeTickets.rows,
            history: historyTickets.rows
        });
    } catch (err) {
        console.error('Error fetching user dashboard:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- API: Get Audit Log for a Round ---
app.get('/api/audit/:tierId/:roundNo', async (req, res) => {
    try {
        const { tierId, roundNo } = req.params;
        
        // Check if draw has happened
        const drawCheck = await pool.query(`
            SELECT COUNT(*) as count FROM winners_history 
            WHERE tier_id = $1 AND round_no = $2
        `, [tierId, roundNo]);
        
        const drawHappened = parseInt(drawCheck.rows[0].count) > 0;
        
        // Get all tickets with transaction hashes
        const tickets = await pool.query(`
            SELECT 
                t.number_val,
                t.owner_id,
                t.status,
                t.transaction_hash,
                t.purchase_timestamp,
                pr.full_name,
                pr.phone,
                pr.start_time as payment_time
            FROM tickets t
            LEFT JOIN payment_requests pr ON t.tier_id = pr.tier_id 
                AND t.round_no = pr.round_no 
                AND t.number_val = pr.ticket_number
            WHERE t.tier_id = $1 AND t.round_no = $2
            ORDER BY t.number_val ASC
        `, [tierId, roundNo]);
        
        // Get draw seed info if available
        const seedInfo = await pool.query(`
            SELECT * FROM draw_seeds 
            WHERE tier_id = $1 AND round_no = $2
        `, [tierId, roundNo]);
        
        res.json({
            tierId: parseInt(tierId),
            roundNo: parseInt(roundNo),
            drawHappened,
            tickets: tickets.rows,
            seedInfo: seedInfo.rows[0] || null,
            totalTickets: tickets.rows.length,
            soldTickets: tickets.rows.filter(t => t.status === 'sold').length
        });
    } catch (err) {
        console.error('Error fetching audit log:', err);
        res.status(500).send(err.message);
    }
});

// --- API: Get Draw Countdown Status ---
app.get('/api/countdown/:tierId', async (req, res) => {
    try {
        const tierId = req.params.tierId;
        const roundRes = await pool.query("SELECT current_round FROM game_rounds WHERE tier_id = $1", [tierId]);
        const round = roundRes.rows[0].current_round;
        
        const soldCount = await pool.query(`
            SELECT count(*) as count 
            FROM tickets 
            WHERE tier_id = $1 AND status = 'sold' AND round_no = $2
        `, [tierId, round]);
        
        const sold = parseInt(soldCount.rows[0].count);
        const isFull = sold === 100;
        
        // Get countdown start time (when 100th ticket was sold)
        let countdownStart = null;
        if (isFull) {
            const lastSold = await pool.query(`
                SELECT purchase_timestamp 
                FROM tickets 
                WHERE tier_id = $1 AND round_no = $2 AND status = 'sold'
                ORDER BY purchase_timestamp DESC
                LIMIT 1
            `, [tierId, round]);
            countdownStart = lastSold.rows[0]?.purchase_timestamp;
        }
        
        // Get draw seed hash (published before draw)
        const seedInfo = await pool.query(`
            SELECT server_seed_hash, created_at 
            FROM draw_seeds 
            WHERE tier_id = $1 AND round_no = $2
        `, [tierId, round]);
        
        res.json({
            tierId: parseInt(tierId),
            round,
            sold,
            isFull,
            countdownStart,
            seedHash: seedInfo.rows[0]?.server_seed_hash || null,
            seedCreatedAt: seedInfo.rows[0]?.created_at || null
        });
    } catch (err) {
        console.error('Error fetching countdown:', err);
        res.status(500).send(err.message);
    }
});

// --- API: Verify Provably Fair Draw ---
app.get('/api/verify/:tierId/:roundNo', async (req, res) => {
    try {
        const { tierId, roundNo } = req.params;
        
        const seedInfo = await pool.query(`
            SELECT * FROM draw_seeds 
            WHERE tier_id = $1 AND round_no = $2
        `, [tierId, roundNo]);
        
        if (!seedInfo.rows[0]) {
            return res.status(404).json({ error: 'Draw seed not found' });
        }
        
        const seed = seedInfo.rows[0];
        const winners = await pool.query(`
            SELECT * FROM winners_history 
            WHERE tier_id = $1 AND round_no = $2
        `, [tierId, roundNo]);
        
        if (!winners.rows[0]) {
            return res.status(404).json({ error: 'Draw results not found' });
        }
        
        // Verify the draw
        const verification = verifyProvablyFairDraw(
            seed.server_seed,
            seed.client_seed || '',
            seed.combined_seed,
            seed.draw_hash,
            winners.rows[0]
        );
        
        res.json({
            tierId: parseInt(tierId),
            roundNo: parseInt(roundNo),
            seed: {
                serverSeedHash: seed.server_seed_hash,
                serverSeed: seed.server_seed,
                clientSeed: seed.client_seed,
                combinedSeed: seed.combined_seed,
                drawHash: seed.draw_hash,
                revealedAt: seed.revealed_at
            },
            winners: winners.rows[0],
            verification
        });
    } catch (err) {
        console.error('Error verifying draw:', err);
        res.status(500).send(err.message);
    }
});

// --- API: Admin Dashboard ---
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                pr.id,
                pr.tier_id,
                pr.ticket_number,
                pr.round_no,
                pr.full_name,
                pr.phone,
                pr.screenshot_url,
                pr.start_time,
                pr.status,
                t.name as tier_name
            FROM payment_requests pr
            LEFT JOIN tiers t ON pr.tier_id = t.id
            ORDER BY pr.start_time DESC
            LIMIT 100
        `);
        res.json(result.rows);
    } catch (err) { 
        console.error('Admin dashboard error:', err);
        res.status(500).send(err.message); 
    }
});

// --- API: Admin Dashboard by Status ---
app.get('/api/admin/dashboard/:status', async (req, res) => {
    try {
        const status = req.params.status;
        const result = await pool.query(`
            SELECT 
                pr.id,
                pr.tier_id,
                pr.ticket_number,
                pr.round_no,
                pr.full_name,
                pr.phone,
                pr.screenshot_url,
                pr.start_time,
                pr.status,
                t.name as tier_name
            FROM payment_requests pr
            LEFT JOIN tiers t ON pr.tier_id = t.id
            WHERE pr.status = $1
            ORDER BY pr.start_time DESC
            LIMIT 100
        `, [status]);
        res.json(result.rows);
    } catch (err) { 
        console.error('Admin dashboard error:', err);
        res.status(500).send(err.message); 
    }
});

// --- API: Submit Winner Verification ---
app.post('/api/winner/verify', async (req, res) => {
    try {
        const { tierId, roundNo, ticketNumber, userId, fullName, paymentMethod, accountNumber } = req.body;
        
        // Update verification status
        await pool.query(`
            UPDATE winners_verification 
            SET full_name = $1, payment_method = $2, account_number = $3, status = 'verification_submitted', verified_at = NOW()
            WHERE tier_id = $4 AND round_no = $5 AND ticket_number = $6 AND user_id = $7
        `, [fullName, paymentMethod, accountNumber, tierId, roundNo, ticketNumber, userId]);
        
        // Notify Admin
        const tierName = tierId == 3 ? "🥇 GOLD" : tierId == 2 ? "🥈 SILVER" : "🥉 BRONZE";
        const placeText = req.body.place == 1 ? '1st' : req.body.place == 2 ? '2nd' : '3rd';
        
        const keyboard = new InlineKeyboard()
            .text("✅ Confirm Payout", `confirm_payout_${tierId}_${roundNo}_${ticketNumber}_${userId}`)
            .text("❌ Reject", `reject_payout_${tierId}_${roundNo}_${ticketNumber}_${userId}`);
        
        await bot.api.sendMessage(process.env.ADMIN_ID, 
            `🔔 **WINNER VERIFICATION SUBMITTED**\n\n` +
            `🔹 **Tier:** ${tierName}\n` +
            `🔹 **Place:** ${placeText}\n` +
            `🔹 **Ticket:** #${ticketNumber}\n` +
            `🔹 **Round:** #${roundNo}\n` +
            `🔹 **Name:** ${fullName}\n` +
            `🔹 **Payment Method:** ${paymentMethod}\n` +
            `🔹 **Account:** ${accountNumber}`,
            { reply_markup: keyboard }
        );
        
        res.json({ success: true });
    } catch (err) {
        console.error('Verification error:', err);
        res.status(500).send(err.message);
    }
});

// --- API: Get Winner Verification Status ---
app.get('/api/winner/status/:tierId/:roundNo/:ticketNumber', async (req, res) => {
    try {
        const { tierId, roundNo, ticketNumber } = req.params;
        const result = await pool.query(`
            SELECT * FROM winners_verification 
            WHERE tier_id = $1 AND round_no = $2 AND ticket_number = $3
        `, [tierId, roundNo, ticketNumber]);
        
        res.json(result.rows[0] || null);
    } catch (err) {
        console.error('Status error:', err);
        res.status(500).send(err.message);
    }
});

// --- API: Get Draw Status for Animation ---
app.get('/api/draw/:tierId', async (req, res) => {
    try {
        const tierId = req.params.tierId;
        const roundRes = await pool.query("SELECT current_round FROM game_rounds WHERE tier_id = $1", [tierId]);
        const round = roundRes.rows[0].current_round;
        
        // Get last draw results
        const drawRes = await pool.query(`
            SELECT round_no, w1_num as first, w2_num as second, w3_num as third, created_at
            FROM winners_history 
            WHERE tier_id = $1 
            ORDER BY id DESC 
            LIMIT 1
        `, [tierId]);
        
        // Check if draw is in progress (100 sold tickets)
        const soldCount = await pool.query(`
            SELECT count(*) as count 
            FROM tickets 
            WHERE tier_id = $1 AND status = 'sold' AND round_no = $2
        `, [tierId, round]);
        
        const isDrawReady = parseInt(soldCount.rows[0].count) === 100;
        
        res.json({
            tierId: parseInt(tierId),
            currentRound: round,
            isDrawReady,
            lastDraw: drawRes.rows[0] || null
        });
    } catch (err) {
        console.error('Draw status error:', err);
        res.status(500).send(err.message);
    }
});

// --- API: Upload Payment ---
app.post('/api/upload-payment', upload.single('photo'), async (req, res) => {
    const { userId, tierId, number, phone, round, fullName, transactionHash, numbers } = req.body;
    const tierName = tierId == 3 ? "🥇 GOLD" : tierId == 2 ? "🥈 SILVER" : "🥉 BRONZE";
    
    let ticketNumbers = [];
    if (numbers) {
        try {
            const parsed = JSON.parse(numbers);
            if (Array.isArray(parsed)) {
                ticketNumbers = parsed
                    .map(n => parseInt(n))
                    .filter(n => !Number.isNaN(n));
            }
        } catch (e) {
            console.error('Error parsing numbers in upload-payment:', e);
        }
    }
    if (ticketNumbers.length === 0 && number) {
        const single = parseInt(number);
        if (!Number.isNaN(single)) {
            ticketNumbers = [single];
        }
    }
    if (ticketNumbers.length === 0) {
        return res.status(400).json({ error: 'No valid ticket numbers provided' });
    }
    
    // Use fullName from form, fallback to Telegram if not provided
    let userFullName = fullName || 'Unknown User';
    if(!fullName) {
        try {
            const userInfo = await bot.api.getChat(userId);
            userFullName = userInfo.first_name + (userInfo.last_name ? ' ' + userInfo.last_name : '');
        } catch(e) {
            console.error('Error fetching user info:', e);
        }
    }
    
    const startTime = new Date();
    const startTimeStr = startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    let tierPrice = 0;
    try {
        const priceRes = await pool.query('SELECT price FROM tiers WHERE id = $1', [tierId]);
        if (priceRes.rows[0] && priceRes.rows[0].price != null) {
            tierPrice = parseInt(priceRes.rows[0].price, 10) || 0;
        }
    } catch (e) {
        console.error('Error fetching tier price:', e);
    }
    
    const successfulTickets = [];
    try {
        for (const num of ticketNumbers) {
            // CRITICAL FIX: Only update if status is 'available' to prevent race conditions
            const result = await pool.query(
                "UPDATE tickets SET status = 'pending', owner_id = $1, payment_phone = $2, screenshot_url = $3, transaction_hash = $4, purchase_timestamp = NOW() WHERE tier_id = $5 AND number_val = $6 AND round_no = $7 AND status = 'available'", 
                [userId, phone, req.file.path, transactionHash || null, tierId, num, round]
            );
            
            if (result.rowCount > 0) {
                successfulTickets.push(num);
            }
        }
    } catch (e) {
        console.error('Error updating tickets for payment:', e);
        return res.status(500).json({ error: 'Database error processing tickets' });
    }

    if (successfulTickets.length === 0) {
        // All selected tickets were taken
        return res.status(409).send('Selected tickets are no longer available. Please choose different tickets.');
    }

    // Use only successful tickets for the rest of the process
    
    // Store transaction records for audit trail
    if (transactionHash) {
        try {
            const txPromises = successfulTickets.map(num =>
                pool.query(`
                    INSERT INTO ticket_transactions (tier_id, round_no, ticket_number, user_id, transaction_hash, status)
                    VALUES ($1, $2, $3, $4, $5, 'pending')
                    ON CONFLICT (tier_id, round_no, ticket_number) DO UPDATE 
                    SET transaction_hash = EXCLUDED.transaction_hash,
                        status = 'pending'
                `, [tierId, round, num, userId, transactionHash])
            );
            await Promise.all(txPromises);
        } catch (e) {
            console.error('Error storing ticket transactions:', e);
        }
    }

    // Store payment requests permanently in admin dashboard table (one per ticket)
    try {
        const paymentPromises = successfulTickets.map(num =>
            pool.query(`
                INSERT INTO payment_requests (tier_id, ticket_number, round_no, user_id, full_name, phone, screenshot_url, start_time, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
            `, [tierId, num, round, userId, userFullName, phone, req.file.path, startTime])
        );
        await Promise.all(paymentPromises);
    } catch(e) {
        console.error('Error storing payment request:', e);
    }

    try {
        const numbersLabel = successfulTickets
            .map(n => `🎟 ${String(n).padStart(2, '0')}`)
            .join(', ');
        const shortHash = (transactionHash || '').toString().slice(0, 16) || 'nohash';
        const count = successfulTickets.length;
        const expectedTotal = tierPrice * count;

        const keyboard = new InlineKeyboard()
            .text("✅ Approve All", `approve_group_${tierId}_${round}_${userId}_${shortHash}`)
            .text("❌ Reject All", `reject_group_${tierId}_${round}_${userId}_${shortHash}`);

        await bot.api.sendPhoto(process.env.ADMIN_ID, new InputFile(req.file.path), {
            caption: `🔔 **አዲስ ክፍያ**\n\n` +
                `🔹 **ደረጃ:** ${tierName}\n` +
                `🔹 **ትኬቶች:** ${numbersLabel}\n` +
                `🔹 **ብዛት:** ${count}\n` +
                `🔹 **የሚጠበቀው ድምር / Expected Total:** ${expectedTotal} ETB\n` +
                `🔹 **ዙር:** #${round}\n` +
                `🔹 **ስልክ:** ${phone}\n` +
                `🔹 **ስም:** ${userFullName}\n` +
                `🔹 **ጊዜ:** ${startTimeStr}`,
            reply_markup: keyboard
        });
    } catch (e) {
        console.error('Error sending admin payment photo:', e);
    }

    res.json({ success: true });
});

// --- API: Deposit Request (from webapp) ---
app.post('/api/deposit-request', async (req, res) => {
    try {
        const { userId, paymentMethod, accountNumber, amount, transactionReference, notes, validityExpires } = req.body;
        if (!userId || !paymentMethod || !amount) return res.status(400).json({ error: 'Missing fields' });

        const insertRes = await pool.query(`
            INSERT INTO deposit_requests (user_id, payment_method, account_number, amount_etb, transaction_reference, notes, validity_expires)
            VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
        `, [userId, paymentMethod, accountNumber, amount, transactionReference || null, notes || null, validityExpires ? new Date(validityExpires) : null]);

        const deposit = insertRes.rows[0];

        // Notify Admin via Telegram with Approve/Reject buttons
        const adminKeyboard = new InlineKeyboard()
            .text('✅ Approve', `approve_deposit_${deposit.id}`)
            .text('❌ Reject', `reject_deposit_${deposit.id}`);

        const msg = `🔔 New Deposit Request\n\n` +
            `• User ID: ${deposit.user_id}\n` +
            `• Method: ${deposit.payment_method}\n` +
            `• Account: ${deposit.account_number || 'N/A'}\n` +
            `• Amount: ${deposit.amount_etb} ETB\n` +
            `• TX Ref: ${deposit.transaction_reference || 'N/A'}\n` +
            `• Notes: ${deposit.notes || '-'}\n` +
            `• Created: ${new Date(deposit.created_at).toLocaleString()}`;

        await bot.api.sendMessage(process.env.ADMIN_ID, msg, { reply_markup: adminKeyboard });

        res.json({ success: true, depositId: deposit.id });
    } catch (e) {
        console.error('Error in /api/deposit-request:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- API: Admin approves deposit with explicit ETB input and bank reference ---
app.post('/api/admin/approve-deposit', express.json(), async (req, res) => {
    try {
        const { depositId, received_etb, bank_reference, adminId } = req.body || {};
        if (!depositId || !received_etb) return res.status(400).json({ error: 'depositId and received_etb required' });

        const depRes = await pool.query('SELECT * FROM deposit_requests WHERE id = $1', [depositId]);
        const dep = depRes.rows[0];
        if (!dep) return res.status(404).json({ error: 'deposit not found' });
        if (dep.status !== 'pending') return res.status(409).json({ error: `Deposit already ${dep.status}` });

        // Check Redis for duplicate bank reference
        if (bank_reference) {
            try {
                const client = await getRedis();
                if (client) {
                    const key = `bank_ref:${bank_reference}`;
                    const exists = await client.get(key);
                    if (exists) {
                        await pool.query('UPDATE deposit_requests SET status=$1, processed_at=NOW(), admin_id=$2 WHERE id=$3', ['duplicate', adminId || null, depositId]);
                        return res.status(409).json({ error: 'duplicate_bank_reference' });
                    }
                }
            } catch (e) { console.warn('Redis check failed', e); }
        }

        // Convert ETB -> EUR and to integer cents
        const amountEtb = parseFloat(received_etb);
        const amountEur = parseFloat((amountEtb / EUR_TO_ETB));
        const amountCents = Math.round(Number(amountEur) * 100);

        // Insert into transaction registry (store both numeric and cents for compatibility)
        const txRef = bank_reference || (dep.transaction_reference || `deposit-${dep.id}`);
        await pool.query(`
            INSERT INTO transaction_registry (tx_reference, user_id, amount_etb, amount_eur, amount_cents, admin_id, processed_at)
            VALUES ($1,$2,$3,$4,$5,$6,NOW())
        `, [txRef, dep.user_id, amountEtb, amountEur, amountCents, adminId || null]);

        // Mark Redis key for this bank reference
        if (bank_reference) {
            try {
                const client = await getRedis();
                if (client) {
                    const key = `bank_ref:${bank_reference}`;
                    await client.set(key, '1', { EX: 30 * 24 * 3600 });
                }
            } catch (e) { console.warn('Failed to set Redis bank_ref key', e); }
        }

        // Credit user wallet in integer cents. Fallback to balance_eur if cents column not present.
        try {
            const existing = await pool.query('SELECT balance_cents, balance_eur FROM user_wallets WHERE user_id = $1', [dep.user_id]);
            if (existing.rows.length === 0) {
                // Insert with cents column when available
                try {
                    await pool.query('INSERT INTO user_wallets (user_id, balance_cents) VALUES ($1,$2)', [dep.user_id, amountCents]);
                } catch (ie) {
                    // fallback to legacy column
                    await pool.query('INSERT INTO user_wallets (user_id, balance_eur) VALUES ($1,$2)', [dep.user_id, amountEur]);
                }
            } else {
                const row = existing.rows[0];
                if (row.balance_cents !== null && typeof row.balance_cents !== 'undefined') {
                    const prev = parseInt(row.balance_cents || 0, 10);
                    const newBal = prev + amountCents;
                    await pool.query('UPDATE user_wallets SET balance_cents = $1 WHERE user_id = $2', [newBal, dep.user_id]);
                } else {
                    // Legacy path
                    const prevEur = parseFloat(row.balance_eur || 0);
                    const newBalEur = prevEur + amountEur;
                    await pool.query('UPDATE user_wallets SET balance_eur = $1 WHERE user_id = $2', [newBalEur, dep.user_id]);
                }
            }
        } catch (e) { console.error('Error crediting user wallet (admin api):', e); }

        // Update deposit_request record
        await pool.query(`
            UPDATE deposit_requests SET status=$1, admin_id=$2, processed_at=NOW(), amount_etb=$3, transaction_reference=$4
            WHERE id = $5
        `, ['approved', adminId || null, amountEtb, txRef, depositId]);

        // Notify user asynchronously
        try { await bot.api.sendMessage(dep.user_id, `✅ Your deposit of ${amountEtb} ETB (${amountEur} EUR) has been approved and credited to your wallet.`); } catch(e) { console.warn('Notify user failed', e); }

        return res.json({ success: true, credited_eur: amountEur });
    } catch (e) {
        console.error('admin approve deposit error', e);
        return res.status(500).json({ error: 'server' });
    }
});

// --- Cron endpoint: Inactivity check (for 5-day reminders) ---
app.get('/cron/inactivity-check', async (req, res) => {
    try {
        const secret = req.query.secret || req.headers['x-cron-secret'];
        if (secret !== CRON_SECRET) return res.status(403).send('Forbidden');

        // Find users whose last ticket purchase date is exactly 5 days ago (and not purchased since)
        const rows = await pool.query(`
            SELECT user_id, MAX(purchase_timestamp) AS last_entry
            FROM tickets
            GROUP BY user_id
            HAVING date_trunc('day', MAX(purchase_timestamp)) = (CURRENT_DATE - INTERVAL '5 days')
        `);

        const links = buildWebappLinks();

        for (const r of rows.rows) {
            try {
                const userId = r.user_id;
                const keyboard = new InlineKeyboard()
                    .url('📥 Deposit Now', links.web || (links.botLink))
                    .url('🎮 Play Gold Grid', (links.web ? `${links.web}?open=gold` : links.botLink));
                await bot.api.sendMessage(userId, `💰 Don't let your luck expire! You haven't played in 5 days. The Gold Jackpot is waiting for you!`, { reply_markup: keyboard });
            } catch (e) {
                console.error('Error sending inactivity msg to user', r.user_id, e);
            }
        }

        res.json({ success: true, count: rows.rows.length });
    } catch (e) {
        console.error('Error in /cron/inactivity-check:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- Cron endpoint: Group summary (12-hour) ---
app.get('/cron/group-summary', async (req, res) => {
    try {
        const secret = req.query.secret || req.headers['x-cron-secret'];
        if (secret !== CRON_SECRET) return res.status(403).send('Forbidden');

        // For each tier, fetch sold counts and last draw time
        const tiers = [1,2,3];
        const parts = [];
        for (const t of tiers) {
            const soldRes = await pool.query("SELECT count(*) as count FROM tickets WHERE tier_id = $1 AND status = 'sold'", [t]);
            const sold = parseInt(soldRes.rows[0].count || 0);
            const lastDraw = await pool.query("SELECT created_at FROM winners_history WHERE tier_id = $1 ORDER BY id DESC LIMIT 1", [t]);
            const lastDrawAt = lastDraw.rows[0] ? new Date(lastDraw.rows[0].created_at) : null;
            parts.push({ tier: t, sold, lastDrawAt });
        }

        // If any tier has no recent draw within 12 hours, post summary
        const twelveAgo = Date.now() - (12 * 60 * 60 * 1000);
        const needPost = parts.some(p => !p.lastDrawAt || p.lastDrawAt.getTime() < twelveAgo);
        if (!needPost) {
            return res.json({ success: true, posted: false, reason: 'Recent draw exists' });
        }

        const tierNames = {1: 'Bronze (0.5 EUR)', 2: 'Silver (1.5 EUR)', 3: 'Gold (2.5 EUR)'};
        const lines = ['🔥 Current Hot Pools:'];
        for (const p of parts) {
            lines.push(`${p.tier === 3 ? 'Gold' : p.tier === 2 ? 'Silver' : 'Bronze'} (${p.tier === 3 ? '2.5' : p.tier === 2 ? '1.5' : '0.5'} EUR): ${p.sold}/100 filled`);
        }
        lines.push('\nJoin now before the computerized selection starts!');
        const links = buildWebappLinks();
        lines.push(`\n${links.web} • ${links.botLink}`);

        const groupId = process.env.WINNERS_GROUP_ID || '@siketlotto';
        await bot.api.sendMessage(groupId, lines.join('\n'));

        res.json({ success: true, posted: true });
    } catch (e) {
        console.error('Error in /cron/group-summary:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- ADMIN CALLBACKS ---
// Approve deposit callback (admin)
bot.callbackQuery(/approve_deposit_(\d+)/, async (ctx) => {
    const [_, depositId] = ctx.match;
    try {
        const depRes = await pool.query('SELECT * FROM deposit_requests WHERE id = $1', [depositId]);
        const dep = depRes.rows[0];
        if (!dep) {
            await ctx.answerCallbackQuery({ text: 'Deposit not found', show_alert: true });
            return;
        }
        if (dep.status !== 'pending') {
            await ctx.answerCallbackQuery({ text: `Deposit already ${dep.status}`, show_alert: true });
            return;
        }

        // Duplicate detection by transaction reference (Redis first, fallback to DB)
        try {
            const client = await getRedis();
            if (dep.transaction_reference && client) {
                const key = `bank_ref:${dep.transaction_reference}`;
                const exists = await client.get(key);
                if (exists) {
                    await pool.query('UPDATE deposit_requests SET status = $1, processed_at = NOW(), admin_id = $2 WHERE id = $3', ['duplicate', ctx.from.id, depositId]);
                    await ctx.answerCallbackQuery({ text: 'Duplicate transaction detected (redis) — marked as duplicate', show_alert: true });
                    try { await bot.api.sendMessage(dep.user_id, `❌ Your deposit (TX: ${dep.transaction_reference}) appears to be a duplicate and was not approved. Please contact support.`); } catch(e){}
                    return;
                }
            }

            // DB fallback check
            if (dep.transaction_reference) {
                const dup = await pool.query('SELECT * FROM transaction_registry WHERE tx_reference = $1', [dep.transaction_reference]);
                if (dup.rows.length > 0) {
                    await pool.query('UPDATE deposit_requests SET status = $1, processed_at = NOW(), admin_id = $2 WHERE id = $3', ['duplicate', ctx.from.id, depositId]);
                    await ctx.answerCallbackQuery({ text: 'Duplicate transaction detected — marked as duplicate', show_alert: true });
                    try { await bot.api.sendMessage(dep.user_id, `❌ Your deposit (TX: ${dep.transaction_reference}) appears to be a duplicate and was not approved. Please contact support.`); } catch(e){}
                    return;
                }
            }
        } catch(e) {
            console.warn('Duplicate detection check failed', e);
        }

        // Convert ETB -> EUR
        const amountEtb = parseFloat(dep.amount_etb || 0);
        const amountEur = parseFloat((amountEtb / EUR_TO_ETB).toFixed(2));

        // Insert into registry (unique constraint prevents duplicates)
        try {
            const txRef = dep.transaction_reference || `deposit-${dep.id}`;
            await pool.query(`
                INSERT INTO transaction_registry (tx_reference, user_id, amount_etb, amount_eur, admin_id, processed_at)
                VALUES ($1,$2,$3,$4,$5,NOW())
            `, [txRef, dep.user_id, amountEtb, amountEur, ctx.from.id]);

            // If Redis available and transaction reference present, mark it to prevent duplicates
            try {
                const client = await getRedis();
                if (client && dep.transaction_reference) {
                    const key = `bank_ref:${dep.transaction_reference}`;
                    await client.set(key, '1', { EX: 30 * 24 * 3600 }); // keep for 30 days
                }
            } catch (e) {
                console.warn('Failed to set Redis bank_ref key', e);
            }
        } catch (e) {
            console.error('Error inserting into transaction_registry:', e);
        }

        // Credit user wallet (upsert)
        try {
            const existing = await pool.query('SELECT balance_eur FROM user_wallets WHERE user_id = $1', [dep.user_id]);
            if (existing.rows.length === 0) {
                await pool.query('INSERT INTO user_wallets (user_id, balance_eur) VALUES ($1,$2)', [dep.user_id, amountEur]);
            } else {
                const newBal = parseFloat(existing.rows[0].balance_eur || 0) + amountEur;
                await pool.query('UPDATE user_wallets SET balance_eur = $1 WHERE user_id = $2', [newBal, dep.user_id]);
            }
        } catch (e) {
            console.error('Error crediting user wallet:', e);
        }

        // Mark deposit as approved
        await pool.query('UPDATE deposit_requests SET status = $1, admin_id = $2, processed_at = NOW() WHERE id = $3', ['approved', ctx.from.id, depositId]);

        // Notify user
        try {
            await bot.api.sendMessage(dep.user_id, `✅ Your deposit of ${amountEtb} ETB (${amountEur} EUR) has been approved and credited to your wallet.`);
        } catch (e) {
            console.error('Error notifying user about deposit approval:', e);
        }

        await ctx.answerCallbackQuery({ text: 'Deposit approved and wallet credited', show_alert: false });
        try { await ctx.editMessageText((ctx.callbackQuery.message && ctx.callbackQuery.message.text ? ctx.callbackQuery.message.text + '\n\n✅ Approved' : '✅ Approved')); } catch(e){}
    } catch (e) {
        console.error('approve_deposit error:', e);
        await ctx.answerCallbackQuery({ text: 'Error approving deposit', show_alert: true });
    }
});

// Reject deposit callback (admin)
bot.callbackQuery(/reject_deposit_(\d+)/, async (ctx) => {
    const [_, depositId] = ctx.match;
    try {
        const depRes = await pool.query('SELECT * FROM deposit_requests WHERE id = $1', [depositId]);
        const dep = depRes.rows[0];
        if (!dep) {
            await ctx.answerCallbackQuery({ text: 'Deposit not found', show_alert: true });
            return;
        }
        if (dep.status !== 'pending') {
            await ctx.answerCallbackQuery({ text: `Deposit already ${dep.status}`, show_alert: true });
            return;
        }

        await pool.query('UPDATE deposit_requests SET status = $1, admin_id = $2, processed_at = NOW() WHERE id = $3', ['rejected', ctx.from.id, depositId]);
        try { await bot.api.sendMessage(dep.user_id, `❌ Your deposit request (${dep.transaction_reference || 'no ref'}) was rejected by admin. Please contact support.`); } catch(e){}

        await ctx.answerCallbackQuery({ text: 'Deposit rejected', show_alert: false });
        try { await ctx.editMessageText((ctx.callbackQuery.message && ctx.callbackQuery.message.text ? ctx.callbackQuery.message.text + '\n\n❌ Rejected' : '❌ Rejected')); } catch(e){}
    } catch (e) {
        console.error('reject_deposit error:', e);
        await ctx.answerCallbackQuery({ text: 'Error rejecting deposit', show_alert: true });
    }
});
// Group approval for multi-ticket payments
bot.callbackQuery(/approve_group_(\d+)_(\d+)_(\d+)_([0-9a-fA-F]+)/, async (ctx) => {
    const [_, tId, rnd, uId, shortHash] = ctx.match;
    try {
        const txRes = await pool.query(`
            SELECT ticket_number 
            FROM ticket_transactions 
            WHERE tier_id = $1 AND round_no = $2 AND user_id = $3
              AND transaction_hash LIKE $4 || '%'
        `, [tId, rnd, uId, shortHash]);
        const nums = txRes.rows.map(r => r.ticket_number);
        if (nums.length === 0) {
            await ctx.answerCallbackQuery({ text: 'No tickets found for this payment', show_alert: true });
            return;
        }

        await pool.query(
            'UPDATE tickets SET status = $1 WHERE tier_id = $2 AND round_no = $3 AND number_val = ANY($4::int[])',
            ['sold', tId, rnd, nums]
        );

        // Schedule grouped purchase alert to the winners group
        try { schedulePurchaseAlert(tId, nums.length); } catch(e) { console.error('schedulePurchaseAlert error:', e); }

        try {
            await pool.query(`
                UPDATE ticket_transactions
                SET status = 'sold'
                WHERE tier_id = $1 AND round_no = $2 AND ticket_number = ANY($3::int[])
            `, [tId, rnd, nums]);
        } catch (e) {
            console.error('Error updating group transactions:', e);
        }

        try {
            const adminId = ctx.from ? ctx.from.id : null;
            await pool.query(`
                UPDATE payment_requests 
                SET status = 'approved',
                    admin_id = $5,
                    processed_at = NOW()
                WHERE tier_id = $1 AND round_no = $2 AND ticket_number = ANY($3::int[]) AND user_id = $4
            `, [tId, rnd, nums, uId, adminId]);
        } catch (e) {
            console.error('Error updating group payment requests:', e);
        }

        const countRes = await pool.query(
            "SELECT count(*) FROM tickets WHERE tier_id = $1 AND status = 'sold' AND round_no = $2",
            [tId, rnd]
        );
        if (parseInt(countRes.rows[0].count) === 100) {
            const serverSeed = crypto.randomBytes(32).toString('hex');
            const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
            const combinedSeed = serverSeed;
            const drawHash = crypto.createHash('sha256').update(combinedSeed).digest('hex');
            
            await pool.query(`
                INSERT INTO draw_seeds (tier_id, round_no, server_seed_hash, server_seed, combined_seed, draw_hash)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (tier_id, round_no) DO UPDATE 
                SET server_seed_hash = EXCLUDED.server_seed_hash,
                    server_seed = EXCLUDED.server_seed,
                    combined_seed = EXCLUDED.combined_seed,
                    draw_hash = EXCLUDED.draw_hash
            `, [tId, rnd, serverSeedHash, serverSeed, combinedSeed, drawHash]);
            
            const players = await pool.query(
                "SELECT DISTINCT owner_id FROM tickets WHERE tier_id = $1 AND round_no = $2",
                [tId, rnd]
            );
            for (let p of players.rows) {
                await bot.api.sendMessage(p.owner_id, "🔔 ከ5 ደቂቃ በኋላ ዕጣው ይወጣል! መልካም ዕድል!");
            }
            setTimeout(() => runDrawLogic(tId, rnd), 300000);
        }

        const originalCaption = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.caption
            ? ctx.callbackQuery.message.caption
            : '';
        const statusLine = `✅ Approved ${nums.length} tickets`;
        const newCaption = originalCaption
            ? `${originalCaption}\n\n${statusLine}`
            : statusLine;
        await ctx.editMessageCaption({ caption: newCaption });

        await bot.api.sendMessage(
            uId,
            `✅ ክፍያዎ ተፈቅዷል! የትኬት ቁጥሮች: [${nums.map(n => `🎟 ${n}`).join(', ')}]። መልካም ዕድል!`
        );
    } catch (e) {
        console.error('Group approval error:', e);
        await ctx.answerCallbackQuery({ text: 'Error during approval', show_alert: true });
    }
});

bot.callbackQuery(/reject_group_(\d+)_(\d+)_(\d+)_([0-9a-fA-F]+)/, async (ctx) => {
    const [_, tId, rnd, uId, shortHash] = ctx.match;
    try {
        const txRes = await pool.query(`
            SELECT ticket_number 
            FROM ticket_transactions 
            WHERE tier_id = $1 AND round_no = $2 AND user_id = $3
              AND transaction_hash LIKE $4 || '%'
        `, [tId, rnd, uId, shortHash]);
        const nums = txRes.rows.map(r => r.ticket_number);
        if (nums.length === 0) {
            await ctx.answerCallbackQuery({ text: 'No tickets found for this payment', show_alert: true });
            return;
        }

        await pool.query(
            'UPDATE tickets SET status = $1, owner_id = NULL, payment_phone = NULL, screenshot_url = NULL WHERE tier_id = $2 AND round_no = $3 AND number_val = ANY($4::int[])',
            ['available', tId, rnd, nums]
        );

        try {
            await pool.query(`
                UPDATE ticket_transactions 
                SET status = 'rejected' 
                WHERE tier_id = $1 AND round_no = $2 AND ticket_number = ANY($3::int[])
            `, [tId, rnd, nums]);
        } catch (e) {
            console.error('Error updating group transactions (reject):', e);
        }

        try {
            const adminId = ctx.from ? ctx.from.id : null;
            await pool.query(`
                UPDATE payment_requests 
                SET status = 'rejected',
                    admin_id = $5,
                    processed_at = NOW()
                WHERE tier_id = $1 AND round_no = $2 AND ticket_number = ANY($3::int[]) AND user_id = $4
            `, [tId, rnd, nums, uId, adminId]);
        } catch (e) {
            console.error('Error updating group payment requests (reject):', e);
        }

        const originalCaption = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.caption
            ? ctx.callbackQuery.message.caption
            : '';
        const statusLine = `❌ Rejected ${nums.length} tickets`;
        const newCaption = originalCaption
            ? `${originalCaption}\n\n${statusLine}`
            : statusLine;
        await ctx.editMessageCaption({ caption: newCaption });

        await bot.api.sendMessage(
            uId,
            `❌ ክፍያዎ ተቀባይነት አላገኘም ለትኬቶች: [${nums.map(n => `🎟 ${n}`).join(', ')}]። እባክዎ እንደገና ይመለሱ።`
        );
    } catch (e) {
        console.error('Group rejection error:', e);
        await ctx.answerCallbackQuery({ text: 'Error during rejection', show_alert: true });
    }
});

// Single-ticket callbacks (backward compatibility)
bot.callbackQuery(/approve_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, num, uId, rnd] = ctx.match;
    await pool.query('UPDATE tickets SET status = $1 WHERE tier_id = $2 AND number_val = $3 AND round_no = $4', ['sold', tId, num, rnd]);
    try { schedulePurchaseAlert(tId, 1); } catch(e) { console.error('schedulePurchaseAlert error:', e); }
    
    // Update transaction status
    try {
        await pool.query(`
            UPDATE ticket_transactions 
            SET status = 'sold' 
            WHERE tier_id = $1 AND round_no = $2 AND ticket_number = $3
        `, [tId, rnd, num]);
    } catch (e) {
        console.error('Error updating transaction:', e);
    }
    
    // Update payment request status
    try {
        const adminId = ctx.from ? ctx.from.id : null;
        await pool.query(`
            UPDATE payment_requests 
            SET status = $1, admin_id = $6, processed_at = NOW() 
            WHERE tier_id = $2 AND ticket_number = $3 AND round_no = $4 AND user_id = $5
        `, ['approved', tId, num, rnd, uId, adminId]);
    } catch(e) {
        console.error('Error updating payment request:', e);
    }
    
    // Check for draw trigger (100 sold)
    const countRes = await pool.query("SELECT count(*) FROM tickets WHERE tier_id = $1 AND status = 'sold' AND round_no = $2", [tId, rnd]);
    if (parseInt(countRes.rows[0].count) === 100) {
        // Generate and store server seed hash BEFORE draw (provably fair)
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        const combinedSeed = serverSeed; // No client seed for now
        const drawHash = crypto.createHash('sha256').update(combinedSeed).digest('hex');
        
        // Store seed hash (seed itself will be revealed after draw)
        await pool.query(`
            INSERT INTO draw_seeds (tier_id, round_no, server_seed_hash, server_seed, combined_seed, draw_hash)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (tier_id, round_no) DO UPDATE 
            SET server_seed_hash = EXCLUDED.server_seed_hash,
                server_seed = EXCLUDED.server_seed,
                combined_seed = EXCLUDED.combined_seed,
                draw_hash = EXCLUDED.draw_hash
        `, [tId, rnd, serverSeedHash, serverSeed, combinedSeed, drawHash]);
        
        const players = await pool.query("SELECT DISTINCT owner_id FROM tickets WHERE tier_id = $1 AND round_no = $2", [tId, rnd]);
        for(let p of players.rows) {
            await bot.api.sendMessage(p.owner_id, "🔔 ከ5 ደቂቃ በኋላ ዕጣው ይወጣል! መልካም ዕድል!");
        }
        setTimeout(() => runDrawLogic(tId, rnd), 300000); // 5 Mins countdown
    }
    
    // Send approval message (default to Amharic, can be enhanced with language detection)
    await bot.api.sendMessage(uId, `✅ ክፍያዎ ተፈቅዷል! የትኬት ቁጥር: [${num}]። መልካም ዕድል!`);
    const originalCaptionApprove = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.caption
        ? ctx.callbackQuery.message.caption
        : '';
    const approveStatusLine = `✅ Approved Tier ${tId} | #${num}`;
    const approveNewCaption = originalCaptionApprove
        ? `${originalCaptionApprove}\n\n${approveStatusLine}`
        : approveStatusLine;
    await ctx.editMessageCaption({ caption: approveNewCaption });
});

// Reject callback
bot.callbackQuery(/reject_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, num, uId, rnd] = ctx.match;
    await pool.query('UPDATE tickets SET status = $1, owner_id = NULL, payment_phone = NULL, screenshot_url = NULL WHERE tier_id = $2 AND number_val = $3 AND round_no = $4', 
        ['available', tId, num, rnd]);
    
    // Update transaction status
    try {
        await pool.query(`
            UPDATE ticket_transactions 
            SET status = 'rejected' 
            WHERE tier_id = $1 AND round_no = $2 AND ticket_number = $3
        `, [tId, rnd, num]);
    } catch (e) {
        console.error('Error updating transaction:', e);
    }
    
    // Update payment request status
    try {
        const adminId = ctx.from ? ctx.from.id : null;
        await pool.query(`
            UPDATE payment_requests 
            SET status = $1, admin_id = $6, processed_at = NOW() 
            WHERE tier_id = $2 AND ticket_number = $3 AND round_no = $4 AND user_id = $5
        `, ['rejected', tId, num, rnd, uId, adminId]);
    } catch(e) {
        console.error('Error updating payment request:', e);
    }
    
    await bot.api.sendMessage(uId, `❌ ክፍያዎ ተቀባይነት አላገኘም። እባክዎ እንደገና ይሞክሩ።`);
    const originalCaptionReject = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.caption
        ? ctx.callbackQuery.message.caption
        : '';
    const rejectStatusLine = `❌ Rejected Tier ${tId} | #${num}`;
    const rejectNewCaption = originalCaptionReject
        ? `${originalCaptionReject}\n\n${rejectStatusLine}`
        : rejectStatusLine;
    await ctx.editMessageCaption({ caption: rejectNewCaption });
});

// Payout confirmation callbacks
bot.callbackQuery(/confirm_payout_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, rnd, num, uId] = ctx.match;
    
    try {
        const adminId = ctx.from ? ctx.from.id : null;
        await pool.query(`
            UPDATE winners_verification 
            SET status = 'paid', 
                paid_at = NOW(),
                admin_id = $5
            WHERE tier_id = $1 AND round_no = $2 AND ticket_number = $3 AND user_id = $4
        `, [tId, rnd, num, uId, adminId]);
        // Determine prize amount and credit user's EUR wallet
        try {
            // Fetch winner record to know place
            const wres = await pool.query(`SELECT place FROM winners_verification WHERE tier_id=$1 AND round_no=$2 AND ticket_number=$3 AND user_id=$4`, [tId, rnd, num, uId]);
            const place = wres.rows[0] ? parseInt(wres.rows[0].place, 10) : null;
            let creditEur = 0;

            if (parseInt(tId,10) === 1 && place === 3) {
                // Bronze 3rd prize: increment pending_free_tickets in Redis instead of cash payout
                try {
                    const client = await getRedis();
                    if (client) {
                        const key = `pending_free_tickets:${uId}`;
                        await client.incr(key);
                        // Optionally set TTL for pending tickets (e.g., 365 days)
                        await client.expire(key, 365 * 24 * 3600).catch(() => {});
                    }
                } catch (e) { console.warn('Failed to increment pending_free_tickets', e); }
                creditEur = 0;
            } else {
                // fetch tier prizes (assume stored in ETB) and convert
                const tres = await pool.query('SELECT first_prize, second_prize, third_prize FROM tiers WHERE id = $1', [tId]);
                const tierRow = tres.rows[0] || {};
                let prizeEtb = 0;
                if (place === 1) prizeEtb = parseFloat(tierRow.first_prize || 0);
                else if (place === 2) prizeEtb = parseFloat(tierRow.second_prize || 0);
                else if (place === 3) prizeEtb = parseFloat(tierRow.third_prize || 0);
                // convert ETB -> EUR
                creditEur = ((prizeEtb && EUR_TO_ETB) ? (prizeEtb / EUR_TO_ETB) : 0);
                creditEur = parseFloat(creditEur.toFixed(2));
            }

            // Upsert wallet credit
            try {
                const existing = await pool.query('SELECT balance_eur FROM user_wallets WHERE user_id = $1', [uId]);
                if (existing.rows.length === 0) {
                    await pool.query('INSERT INTO user_wallets (user_id, balance_eur) VALUES ($1,$2)', [uId, creditEur]);
                } else {
                    const newBal = parseFloat(existing.rows[0].balance_eur || 0) + creditEur;
                    await pool.query('UPDATE user_wallets SET balance_eur = $1 WHERE user_id = $2', [newBal, uId]);
                }
            } catch (e) { console.error('Error crediting wallet during payout:', e); }

            // record payout in transaction registry
            try {
                const txRef = `payout-${tId}-${rnd}-${num}-${uId}`;
                await pool.query(`INSERT INTO transaction_registry (tx_reference, user_id, amount_etb, amount_eur, admin_id, processed_at) VALUES ($1,$2,$3,$4,$5,NOW())`, [txRef, uId, null, creditEur, adminId]);
            } catch(e) { console.warn('Could not insert payout registry record', e); }

            // Notify user with amount credited
            try {
                await bot.api.sendMessage(uId, `✅ ሽልማትዎ ተረጋግጧል፤ ${creditEur} EUR ከዚህ ጊዜ ጀምሮ በዚህ አካውንትዎ ይታያል.`);
            } catch(e) { console.warn('Notify winner failed', e); }
        } catch (e) {
            console.error('Error computing/crediting payout:', e);
        }

        await ctx.editMessageCaption({ caption: `✅ Payout Confirmed | Tier ${tId} | Round #${rnd} | Ticket #${num}` });
    } catch(e) {
        console.error('Payout confirmation error:', e);
        await ctx.answerCallbackQuery({ text: 'Error confirming payout', show_alert: true });
    }
});

bot.callbackQuery(/reject_payout_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, rnd, num, uId] = ctx.match;
    
    try {
        const adminId = ctx.from ? ctx.from.id : null;
        await pool.query(`
            UPDATE winners_verification 
            SET status = 'rejected',
                admin_id = $5
            WHERE tier_id = $1 AND round_no = $2 AND ticket_number = $3 AND user_id = $4
        `, [tId, rnd, num, uId, adminId]);
        
        await bot.api.sendMessage(uId, `❌ ማረጋገጥዎ ተቀባይነት አላገኘም። እባክዎ ድጋፍ ያግኙ።`);
        await ctx.editMessageCaption({ caption: `❌ Payout Rejected | Tier ${tId} | Round #${rnd} | Ticket #${num}` });
    } catch(e) {
        console.error('Payout rejection error:', e);
        await ctx.answerCallbackQuery({ text: 'Error rejecting payout', show_alert: true });
    }
});

// --- PROVABLY FAIR FUNCTIONS ---
function generateServerSeed() {
    return crypto.randomBytes(32).toString('hex');
}

function hashSeed(seed) {
    return crypto.createHash('sha256').update(seed).digest('hex');
}

function combineSeeds(serverSeed, clientSeed) {
    return serverSeed + clientSeed;
}

function provablyFairDraw(combinedSeed, poolSize) {
    // Create deterministic hash from combined seed
    const hash = crypto.createHash('sha256').update(combinedSeed).digest('hex');
    
    // Use hash to generate random indices
    const indices = [];
    let remaining = Array.from({ length: poolSize }, (_, i) => i);
    
    for (let i = 0; i < 3 && remaining.length > 0; i++) {
        // Use different parts of hash for each selection
        const hashPart = hash.substring(i * 8, (i + 1) * 8);
        const randomValue = parseInt(hashPart, 16);
        const index = randomValue % remaining.length;
        indices.push(remaining[index]);
        remaining.splice(index, 1);
    }
    
    return indices;
}

function verifyProvablyFairDraw(serverSeed, clientSeed, combinedSeed, drawHash, winners) {
    if (!serverSeed || !combinedSeed || !drawHash) {
        return { valid: false, error: 'Seeds not revealed yet' };
    }
    
    // Verify combined seed
    const expectedCombined = combineSeeds(serverSeed, clientSeed || '');
    if (expectedCombined !== combinedSeed) {
        return { valid: false, error: 'Combined seed mismatch' };
    }
    
    // Verify draw hash
    const expectedHash = hashSeed(combinedSeed);
    if (expectedHash !== drawHash) {
        return { valid: false, error: 'Draw hash mismatch' };
    }
    
    return { valid: true, message: 'Draw is provably fair' };
}

async function runDrawLogic(tId, rnd) {
    const sold = await pool.query("SELECT number_val, owner_id, payment_phone FROM tickets WHERE tier_id = $1 AND status = 'sold' AND round_no = $2 ORDER BY purchase_timestamp ASC", [tId, rnd]);
    let pool_arr = sold.rows;
    
    if (pool_arr.length !== 100) {
        console.error(`Error: Expected 100 tickets, got ${pool_arr.length}`);
        return;
    }
    
    // Check if seed already exists (should be created when 100th ticket sold)
    let seedInfo = await pool.query(`
        SELECT * FROM draw_seeds WHERE tier_id = $1 AND round_no = $2
    `, [tId, rnd]);
    
    let serverSeed, serverSeedHash, combinedSeed, drawHash;
    
    if (seedInfo.rows.length === 0) {
        // Generate new seed (shouldn't happen, but safety check)
        serverSeed = generateServerSeed();
        serverSeedHash = hashSeed(serverSeed);
        combinedSeed = combineSeeds(serverSeed, ''); // No client seed for now
        drawHash = hashSeed(combinedSeed);
        
        await pool.query(`
            INSERT INTO draw_seeds (tier_id, round_no, server_seed_hash, server_seed, combined_seed, draw_hash)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [tId, rnd, serverSeedHash, serverSeed, combinedSeed, drawHash]);
    } else {
        // Use existing seed
        const seed = seedInfo.rows[0];
        serverSeed = seed.server_seed;
        serverSeedHash = seed.server_seed_hash;
        combinedSeed = seed.combined_seed;
        drawHash = seed.draw_hash;
    }
    
    // Use provably fair algorithm to select winners
    const winnerIndices = provablyFairDraw(combinedSeed, 100);
    const w = [
        pool_arr[winnerIndices[0]], // 3rd place
        pool_arr[winnerIndices[1]], // 2nd place
        pool_arr[winnerIndices[2]]  // 1st place
    ];
    
    // Save to History
    await pool.query("INSERT INTO winners_history (tier_id, round_no, w1_num, w2_num, w3_num) VALUES ($1,$2,$3,$4,$5)", [tId, rnd, w[2].number_val, w[1].number_val, w[0].number_val]);
    
    // Reveal seeds after draw
    await pool.query(`
        UPDATE draw_seeds 
        SET revealed_at = NOW() 
        WHERE tier_id = $1 AND round_no = $2
    `, [tId, rnd]);

    // Send Admin Log
        await bot.api.sendMessage(process.env.ADMIN_ID, `🏆 **ROUND #${rnd} DRAW COMPLETE**\n1st: 🎟 ${w[2].number_val}\n2nd: 🎟 ${w[1].number_val}\n3rd: 🎟 ${w[0].number_val}`);
    
    // Post winners instantly to Telegram group/channel
    await postWinnersToGroup(tId, rnd, w[2].number_val, w[1].number_val, w[0].number_val);
    await requestWinnerProofs(tId, rnd);

    // Immediately reset Redis grid state for this tier/round so new round can start cleanly
    try {
        const client = await getRedis();
        if (client) {
            // Remove per-ticket reservation keys
            const pattern = `ticket_sold:${tId}:${rnd}:*`;
            try {
                const keys = await client.keys(pattern);
                if (keys && keys.length) await client.del(keys);
            } catch (e) { console.warn('Redis pattern delete failed for ticket_sold', e); }

            // Remove sold counter for this round
            try { await client.del(`tier_sold_count:${tId}:${rnd}`); } catch(e) { console.warn('Failed to delete tier_sold_count', e); }

            // Remove lockdown keys
            try { await client.del(`tier_lockdown:${tId}`); await client.del(`tier_lockdown_start:${tId}`); } catch(e) { console.warn('Failed to delete lockdown keys', e); }

            // Remove purchase buffer and locks so the new round can accept fresh buffers
            try { await client.del(`purchase_buffer:${tId}`); await client.del(`purchase_lock:${tId}`); } catch(e) { /* ignore */ }

            console.log(`✅ Redis grid reset for tier ${tId} round ${rnd}`);
        }
    } catch (e) {
        console.warn('Could not reset Redis grid after draw', e);
    }

    // Store winners in database for verification
    const winners = [
        { place: 1, number: w[2].number_val, userId: w[2].owner_id, tierId: tId, round: rnd },
        { place: 2, number: w[1].number_val, userId: w[1].owner_id, tierId: tId, round: rnd },
        { place: 3, number: w[0].number_val, userId: w[0].owner_id, tierId: tId, round: rnd }
    ];

    // Store winners in database
    for(const winner of winners) {
        try {
            await pool.query(`
                INSERT INTO winners_verification (tier_id, round_no, ticket_number, user_id, place, status)
                VALUES ($1, $2, $3, $4, $5, 'pending')
                ON CONFLICT (tier_id, round_no, ticket_number) DO NOTHING
            `, [winner.tierId, winner.round, winner.number, winner.userId, winner.place]);
        } catch(e) {
            console.error('Error storing winner:', e);
        }
    }

    // Animation sequence: 3rd at 0s, 2nd at 5s, 1st at 10s, each displayed for 3s
    // Animation completes at ~13 seconds (10s delay + 3s display for 1st place)
    // Wait 30 seconds AFTER animation ends (at 43 seconds total), then send winner notifications
    setTimeout(async () => {
        await sendWinnerNotifications(winners);
    }, 43000); // 13s animation + 30s wait = 43 seconds after draw starts

    // Wait 60 seconds total before resetting round (gives time for notifications)
    setTimeout(async () => {
        // Increment and Reset
        let nextR = parseInt(rnd) + 1;
        if(nextR > 1000) nextR = 1;
        await pool.query("UPDATE game_rounds SET current_round = $1 WHERE tier_id = $2", [nextR, tId]);
        for(let n=1; n<=100; n++) await pool.query("INSERT INTO tickets (tier_id, number_val, status, round_no) VALUES ($1,$2,'available',$3)", [tId, n, nextR]);
        
        // Alert Admin
        await bot.api.sendMessage(process.env.ADMIN_ID, `🔄 **ROUND #${nextR} STARTED**\nTier ${tId} is now accepting tickets for Round #${nextR}`);
    }, 60000); // 60 seconds total
}

// Post winners to Telegram group/channel instantly
async function postWinnersToGroup(tierId, roundNo, firstNum, secondNum, thirdNum) {
    try {
        const tierEmojis = { 1: '🥉', 2: '🥈', 3: '🥇' };
        const tierNames = { 1: 'BRONZE', 2: 'SILVER', 3: 'GOLD' };
        const tierNamesAm = { 1: 'ነሐስ', 2: 'ብር', 3: 'ወርቅ' };
        
        const emoji = tierEmojis[tierId] || '🏆';
        const tierName = tierNames[tierId] || 'UNKNOWN';
        const tierNameAm = tierNamesAm[tierId] || 'ያልታወቀ';
        
        // Format: @siketlotto or -1001234567890 (channel/group ID)
        const groupId = process.env.WINNERS_GROUP_ID || '@siketlotto';
        
        // Try to resolve usernames and prize amount
        const tickets = [ {num: firstNum, place: 1}, {num: secondNum, place: 2}, {num: thirdNum, place: 3} ];
        const winnersInfo = [];
        for (const t of tickets) {
            try {
                const ownerRes = await pool.query('SELECT owner_id FROM tickets WHERE tier_id = $1 AND round_no = $2 AND number_val = $3', [tierId, roundNo, t.num]);
                const ownerId = ownerRes.rows[0] ? ownerRes.rows[0].owner_id : null;
                let username = null;
                if (ownerId) {
                    const userRes = await pool.query('SELECT username FROM users WHERE user_id = $1', [ownerId]);
                    username = userRes.rows[0] ? userRes.rows[0].username : null;
                }
                winnersInfo.push({ place: t.place, num: t.num, ownerId, username });
            } catch (e) {
                console.error('Error resolving winner owner:', e);
                winnersInfo.push({ place: t.place, num: t.num, ownerId: null, username: null });
            }
        }

        let prizeEur = null;
        try {
            const tierRes = await pool.query('SELECT first_prize FROM tiers WHERE id = $1', [tierId]);
            const prizeEtb = tierRes.rows[0] ? parseFloat(tierRes.rows[0].first_prize || 0) : 0;
            prizeEur = (prizeEtb && EUR_TO_ETB) ? (prizeEtb / EUR_TO_ETB).toFixed(2) : null;
        } catch (e) {
            console.error('Error fetching tier prize:', e);
        }

        const links = buildWebappLinks();
        const winner = winnersInfo[0];
        const mention = winner.username ? `@${winner.username}` : (winner.ownerId ? `[winner](tg://user?id=${winner.ownerId})` : 'a user');
        const amountText = prizeEur ? `${prizeEur} EUR` : '';
        const footer = 'Safe Draw: 100% Computerized & Fair | ታማኝ ዕጣ፦ 100% በኮምፒውተር የሚመራ።';

        const message = `🏆 BIG WINNER! Congratulations to ${mention} for winning ${amountText}!\n\n` +
            `🎉 Tier: ${tierName} | Round #${String(roundNo).padStart(4,'0')}\n` +
            `🥇 Ticket: ${firstNum} | 🥈 ${secondNum} | 🥉 ${thirdNum}\n\n` +
            `${footer}\n\nJoin: ${links.web} • ${links.botLink}`;

        await bot.api.sendMessage(groupId, message, { parse_mode: 'Markdown' });
        console.log(`✅ Posted winners to ${groupId} for Tier ${tierId}, Round ${roundNo}`);
    } catch (error) {
        console.error('Error posting winners to group:', error);
        // Don't throw - this is not critical for the draw process
    }
}

async function requestWinnerProofs(tierId, roundNo) {
    try {
        const keyboard = new InlineKeyboard()
            .text("📸 Upload 1st Proof", `upload_proof_${tierId}_${roundNo}_1`)
            .row()
            .text("📸 Upload 2nd Proof", `upload_proof_${tierId}_${roundNo}_2`)
            .row()
            .text("📸 Upload 3rd Proof", `upload_proof_${tierId}_${roundNo}_3`);
        await bot.api.sendMessage(process.env.ADMIN_ID, `🏆 Winners announced for Tier ${tierId} | Round #${roundNo}\nPlease upload proof images for 1st, 2nd, and 3rd places.`, { reply_markup: keyboard });
    } catch (e) {
        console.error('Error requesting proofs from admin:', e);
    }
}

bot.callbackQuery(/upload_proof_(\d+)_(\d+)_(1|2|3)/, async (ctx) => {
    const [_, tId, rnd, placeStr] = ctx.match;
    const place = parseInt(placeStr, 10);
    try {
        const res = await pool.query(`
            SELECT w1_num, w2_num, w3_num FROM winners_history
            WHERE tier_id = $1 AND round_no = $2
            ORDER BY id DESC LIMIT 1
        `, [tId, rnd]);
        if (!res.rows[0]) {
            await ctx.answerCallbackQuery({ text: 'No winners found for this round', show_alert: true });
            return;
        }
        const w = res.rows[0];
        const num = place === 1 ? w.w1_num : place === 2 ? w.w2_num : w.w3_num;
        pendingProofs.set(String(ctx.from.id), { tierId: parseInt(tId, 10), roundNo: parseInt(rnd, 10), place, ticketNumber: num });
        const placeText = place === 1 ? '1st' : place === 2 ? '2nd' : '3rd';
        await ctx.answerCallbackQuery({ text: `Send the image for ${placeText} place now`, show_alert: false });
        await ctx.reply(`Please send the proof image for ${placeText} place | Ticket 🎟 ${num}`);
    } catch (e) {
        console.error('Upload proof init error:', e);
        await ctx.answerCallbackQuery({ text: 'Error preparing upload', show_alert: true });
    }
});

bot.on('message:photo', async (ctx) => {
    try {
        const adminId = String(process.env.ADMIN_ID || '');
        if (String(ctx.from.id) !== adminId) return;
        const pending = pendingProofs.get(adminId);
        if (!pending) return;
        const photos = ctx.message.photo || [];
        if (photos.length === 0) return;
        const fileId = photos[photos.length - 1].file_id;
        const tierEmojis = { 1: '🥉', 2: '🥈', 3: '🥇' };
        const tierNames = { 1: 'BRONZE', 2: 'SILVER', 3: 'GOLD' };
        const tierNamesAm = { 1: 'ነሐስ', 2: 'ብር', 3: 'ወርቅ' };
        const placeText = pending.place === 1 ? '1st Place' : pending.place === 2 ? '2nd Place' : '3rd Place';
        const placeTextAm = pending.place === 1 ? '1ኛ ምድብ' : pending.place === 2 ? '2ኛ ምድብ' : '3ኛ ምድብ';
        const emoji = tierEmojis[pending.tierId] || '🏆';
        const tName = tierNames[pending.tierId] || 'TIER';
        const tNameAm = tierNamesAm[pending.tierId] || 'ደረጃ';
        const caption =
            `🏆 ${emoji} ${tName} | Round #${String(pending.roundNo).padStart(4, '0')} | ${placeText}\n` +
            `🎟 Ticket: ${pending.ticketNumber}\n\n` +
            `🏆 ${tNameAm} | ዙር #${String(pending.roundNo).padStart(4, '0')} | ${placeTextAm}\n` +
            `🎟 ትኬት: ${pending.ticketNumber}`;
        const groupId = process.env.WINNERS_GROUP_ID || '@siketlotto';
        await bot.api.sendPhoto(groupId, fileId, { caption });
        await ctx.reply('✅ Proof posted to winners channel.');
        pendingProofs.delete(adminId);
    } catch (e) {
        console.error('Error posting proof image:', e);
        await ctx.reply('❌ Failed to post proof. Please try again.');
    }
});

async function sendWinnerNotifications(winners) {
    const tierNames = { 1: 'Bronze', 2: 'Silver', 3: 'Gold' };
    
    for(const winner of winners) {
        try {
            // Get user's language preference (default to Amharic)
            // In a real scenario, you'd store this in the database
            // For now, we'll send both messages but the user will see based on their app language
            
            const placeText = winner.place === 1 ? '1st' : winner.place === 2 ? '2nd' : '3rd';
            const tierName = tierNames[winner.tierId] || 'Unknown';
            
            // English notification
            const messageEn = `🎉 Congratulations! You have secured a win in the Siket Lottery. To facilitate your prize transfer, please submit your Full Name and your preferred Telebirr or CBE account number. Note: You may utilize any valid account for this transfer. Notice: You are not obligated to tip customer service workers; tipping is strictly based on your willingness. If you are forced to tip, please report it via the comment section on our website.\n\n` +
                `**Place:** ${placeText} Place\n` +
                `**Ticket Number:** 🎟 ${winner.number}\n` +
                `**Tier:** ${tierName}`;
            
            // Amharic notification
            const messageAm = `🎉 እንኳን ደስ አለዎት! የሲኬት ሎተሪ አሸናፊ ሆነዋል። ሽልማትዎን ለማስተላለፍ እንዲረዳን እባክዎ ሙሉ ስምዎን እና የሚመርጡትን የቴሌብር ወይም የሲቢኢ አካውንት ቁጥር ይላኩልን። ማሳሰቢያ፦ ለማንኛውም ትክክለኛ አካውንት ሽልማቱን ማስተላለፍ ይቻላል። ማሳሰቢያ፦ ለደንበኛ አገልግሎት ሰራተኞች ጉርሻ (ቲፕ) የመስጠት ግዴታ የለብዎትም፤ ጉርሻ መስጠት በፍላጎትዎ ላይ ብቻ የተመሰረተ ነው። ሰራተኞች ጉርሻ እንዲሰጡ ካስገደዱዎት እባክዎ በድረ-ገጹ የቅሬታ/አስተያየት መስጫ ላይ ሪፖርት ያድርጉ።\n\n` +
                `**ምድብ:** ${winner.place === 1 ? '1ኛ' : winner.place === 2 ? '2ኛ' : '3ኛ'} ምድብ\n` +
                `**የትኬት ቁጥር:** 🎟 ${winner.number}\n` +
                `**ደረጃ:** ${tierName}`;
            
            const keyboard = new InlineKeyboard()
                .webApp("Verify & Claim Prize", `${process.env.WEBAPP_URL}/verify.html?tier=${winner.tierId}&round=${winner.round}&ticket=${winner.number}&place=${winner.place}`);
            
            // Send both messages - Telegram will show based on user's app language
            // Or send separately based on user preference stored in database
            await bot.api.sendMessage(winner.userId, messageAm, { reply_markup: keyboard });
            // Uncomment below to send English version as well, or implement language detection
            // await bot.api.sendMessage(winner.userId, messageEn, { reply_markup: keyboard });
        } catch(e) {
            console.error(`Error sending winner notification to ${winner.userId}:`, e);
        }
    }
}

bot.command("start", async (ctx) => {
    await getUser(ctx.from.id, ctx.from.username);
    
    // Ensure WEBAPP_URL is properly formatted
    let webAppUrl = process.env.WEBAPP_URL;
    if (!webAppUrl) {
        console.error('⚠️ WEBAPP_URL is not set in environment variables!');
        await ctx.reply('❌ Configuration error: Web app URL not set. Please contact administrator.');
        return;
    }
    
    // Clean up URL: remove trailing slash, ensure https://
    webAppUrl = webAppUrl.trim().replace(/\/$/, '');
    if (!webAppUrl.startsWith('http://') && !webAppUrl.startsWith('https://')) {
        webAppUrl = `https://${webAppUrl}`;
    }
    
    // Use root URL for Web App (server now explicitly handles /)
    // webAppUrl = `${webAppUrl}/index.html`; 
    
    console.log(`🔗 Web App URL configured: ${webAppUrl}`);
    
    try {
        const kb = new InlineKeyboard()
            .webApp("ትኬት ይቁረጡ | Buy Ticket", webAppUrl)
            .row()
            .url("በመረጃ ማዕከል ይግዙ", "https://t.me/Contact_Siketlottery");
        
        await ctx.reply(`ሰላም ${ctx.from.first_name}! 👋\nእንኳን ወደ ስኬት ሎቶ በደህና መጡ!`, { reply_markup: kb });
    } catch (error) {
        console.error('Error creating web app button:', error);
        await ctx.reply('❌ Error loading web app. Please try again later or contact support.');
    }
});

// Error handling
bot.catch((err) => {
    console.error('Error in bot:', err);
});

// Start Server logic
const port = process.env.PORT || 3000;
const domain = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL;
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER_EXTERNAL_URL;

// Keep Awake
setInterval(() => { if (domain) axios.get(domain).catch(() => {}); }, 300000);

// Decide deployment mode: serverless (Vercel) or conventional server
const isVercel = !!process.env.VERCEL || process.env.DEPLOY_TARGET === 'vercel';
const useWebhook = domain && (isProduction || process.env.USE_WEBHOOK === 'true' || isVercel);
const webhookPath = isVercel ? '/api/webhook' : '/webhook';

if (useWebhook) {
    // Webhook Mode: mount webhook at appropriate path
    app.use(webhookPath, webhookCallback(bot, 'express'));

    // Compute webhook URL: prefer explicit WEBHOOK_URL env var (useful on Vercel), else derive from domain
    const explicitWebhook = process.env.WEBHOOK_URL || process.env.TELEGRAM_WEBHOOK_URL;
    const safeDomain = domain ? (domain.startsWith('http') ? domain : `https://${domain}`) : null;
    const derivedWebhook = safeDomain ? (safeDomain.replace(/\/$/, '') + webhookPath) : null;
    const webhookUrl = explicitWebhook || derivedWebhook;

    if (isVercel) {
        // Serverless: do not call app.listen() or bot.start(). Set webhook if provided, export `app` for the platform.
        (async () => {
            if (webhookUrl) {
                try {
                    await bot.api.deleteWebhook({ drop_pending_updates: true });
                    await bot.api.setWebhook(webhookUrl);
                    console.log('✅ Webhook set successfully:', webhookUrl);
                } catch (e) {
                    console.error('❌ Failed to set webhook on Vercel cold start:', e);
                }
            } else {
                console.warn('⚠️ Vercel detected but no WEBHOOK_URL or domain provided — webhook not set.');
            }
        })();

        // Export Express app so Vercel/Serverless can attach the handler
        try { module.exports = app; } catch (e) { /* ignore if not supported */ }
        console.log('⚡ Running in serverless mode — webhook mounted at', webhookPath);
    } else {
        // Regular server process: listen and set webhook on startup
        app.listen(port, async () => {
            console.log(`🌐 Siket Production Server Live on port ${port}`);
            if (webhookUrl) console.log(`🔗 Webhook URL: ${webhookUrl}`);
            try {
                await bot.api.deleteWebhook({ drop_pending_updates: true });
                if (webhookUrl) await bot.api.setWebhook(webhookUrl);
                console.log('✅ Webhook configured');
            } catch (e) { console.error('❌ Failed to configure webhook:', e); }
        });
    }
} else {
    // Long Polling Mode (Development / Local)
    app.listen(port, () => console.log(`🌐 Siket Dev Server Live on port ${port}`));

    // Clear any webhook first and start long polling
    bot.api.deleteWebhook({ drop_pending_updates: true }).then(() => {
        console.log('🔄 Webhooks cleared, starting long polling...');
        bot.start({
            drop_pending_updates: true,
            onStart: (botInfo) => {
                console.log(`🤖 Bot @${botInfo.username} started in Long Polling mode`);
            }
        }).catch(e => {
            if (e.message && e.message.includes('409')) {
                console.error('❌ CONFLICT ERROR: Another instance of the bot is running.');
                console.error('👉 Please stop the other instance (local terminal or other deployment).');
            } else {
                console.error('❌ Bot start error:', e);
            }
        });
    }).catch(e => console.error('Error clearing webhook:', e));
}
