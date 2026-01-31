const { Pool } = require('pg');
require('dotenv').config();

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedisUrl = !!process.env.REDIS_URL || (upstashUrl && upstashToken);

const pool = hasDatabaseUrl ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
}) : null;

let redisClient = null;

(async () => {
    let redisAvailable = false;
    if (upstashUrl && upstashToken) {
        try {
            const { Redis } = require('@upstash/redis');
            redisClient = new Redis({ url: upstashUrl, token: upstashToken });
            redisAvailable = true;
            console.log('✅ Connected to Upstash REST Redis');
        } catch (e) {
            console.warn('⚠️ Unable to init Upstash REST client:', e.message || e);
            redisAvailable = false;
        }
    } else if (process.env.REDIS_URL) {
        try {
            const { createClient } = require('redis');
            redisClient = createClient({ url: process.env.REDIS_URL });
            redisClient.on('error', (e) => console.error('Redis client error:', e));
            await redisClient.connect();
            redisAvailable = true;
            console.log('✅ Connected to TCP Redis');
        } catch (e) {
            console.warn('⚠️ Unable to connect to TCP Redis - skipping Redis checks:', e.message || e);
            redisAvailable = false;
        }
    } else {
        console.log('ℹ️ No Redis URL provided; skipping Redis tests.');
    }

    // If DB is available, ensure required tables exist for testing
    if (hasDatabaseUrl) {
        try {
            console.log('🔧 Ensuring test tables exist...');
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
            console.log('✅ Test tables ready');
        } catch (e) {
            console.warn('⚠️ Could not ensure test tables:', e.message || e);
        }
    }

    // Stress Test: Redis Lockdown Keys
    async function testRedisLockdown() {
        if (!redisAvailable) { console.log('⏭️ Skipping Redis lockdown test'); return; }
        const tierId = 1;
        const lockKey = `tier_lockdown:${tierId}`;
        const startKey = `tier_lockdown_start:${tierId}`;

        console.log('🔄 Setting lockdown keys...');
        await redisClient.set(lockKey, '1', { EX: 230 });
        await redisClient.set(startKey, String(Date.now()), { EX: 230 });

        console.log('✅ Lockdown keys set. Verifying...');
        const lockExists = await redisClient.get(lockKey);
        const startExists = await redisClient.get(startKey);

        if (lockExists && startExists) {
            console.log('✅ Lockdown keys verified. Cleaning up...');
            await redisClient.del(lockKey);
            await redisClient.del(startKey);
            console.log('✅ Lockdown keys cleaned up.');
        } else {
            console.error('❌ Lockdown keys verification failed.');
        }
    }

    // Stress Test: Duplicate Transaction Registry
    async function testTransactionRegistry() {
        if (!hasDatabaseUrl) { console.log('⏭️ Skipping DB transaction registry test (no DATABASE_URL)'); return; }
        const txReference = 'TEST123';
        const userId = 12345;
        const amountETB = 1000;
        const amountEUR = amountETB / 200;

        console.log('🔄 Inserting transaction...');
        try {
            await pool.query(
                'INSERT INTO transaction_registry (tx_reference, user_id, amount_etb, amount_eur) VALUES ($1, $2, $3, $4)',
                [txReference, userId, amountETB, amountEUR]
            );
            console.log('✅ Transaction inserted. Testing duplicate...');

            try {
                await pool.query(
                    'INSERT INTO transaction_registry (tx_reference, user_id, amount_etb, amount_eur) VALUES ($1, $2, $3, $4)',
                    [txReference, userId, amountETB, amountEUR]
                );
                console.error('❌ Duplicate transaction allowed.');
            } catch (e) {
                console.log('✅ Duplicate transaction blocked:', e.message.split('\n')[0]);
            }
        } finally {
            console.log('🔄 Cleaning up transaction...');
            await pool.query('DELETE FROM transaction_registry WHERE tx_reference = $1', [txReference]);
            console.log('✅ Transaction cleaned up.');
        }
    }

    // Stress Test: Balance Update
    async function testBalanceUpdate() {
        if (!hasDatabaseUrl) { console.log('⏭️ Skipping DB balance test (no DATABASE_URL)'); return; }
        const userId = 12345;
        const initialBalance = 10;
        const depositAmount = 5;

        console.log('🔄 Setting initial balance...');
        await pool.query(
            'INSERT INTO user_wallets (user_id, balance_eur) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance_eur = $2',
            [userId, initialBalance]
        );

        console.log('🔄 Updating balance...');
        await pool.query(
            'UPDATE user_wallets SET balance_eur = balance_eur + $1 WHERE user_id = $2',
            [depositAmount, userId]
        );

        const res = await pool.query('SELECT balance_eur FROM user_wallets WHERE user_id = $1', [userId]);
        const updatedBalance = parseFloat(res.rows[0]?.balance_eur || 0);

        if (Math.abs(updatedBalance - (initialBalance + depositAmount)) < 0.0001) {
            console.log('✅ Balance updated correctly.');
        } else {
            console.error('❌ Balance update failed. Expected', initialBalance + depositAmount, 'got', updatedBalance);
        }

        console.log('🔄 Cleaning up balance...');
        await pool.query('DELETE FROM user_wallets WHERE user_id = $1', [userId]);
        console.log('✅ Balance cleaned up.');
    }

    // Run Tests
    await testRedisLockdown();
    await testTransactionRegistry();
    await testBalanceUpdate();

    if (redisClient && redisClient.disconnect) await redisClient.disconnect();
    if (pool && pool.end) await pool.end();
})();