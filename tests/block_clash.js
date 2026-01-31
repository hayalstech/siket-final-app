require('dotenv').config();

// Prefer Upstash REST credentials when provided (safer for serverless/Vercel)
let client = null;
const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

function has(obj, name) { return Object.prototype.hasOwnProperty.call(obj, name); }

(async () => {
    if (upstashUrl && upstashToken) {
        const { Redis } = require('@upstash/redis');
        client = new Redis({ url: upstashUrl, token: upstashToken });
        console.log('Using Upstash REST client');
    } else if (process.env.REDIS_URL) {
        const { createClient } = require('redis');
        client = createClient({ url: process.env.REDIS_URL });
        client.on('error', (e) => console.error('Redis error', e));
        await client.connect();
        console.log('Using TCP redis client');
    } else {
        console.log('No Redis configuration found; cannot run Block Clash test.');
        process.exit(0);
    }

    const tier = 1;
    const soldSetKey = `sold_tickets:${tier}`;
    const block = '42';

    // Clean up before test
    await client.del(soldSetKey);

    // Simulate two users trying to claim the same block at the same time using SADD
    // Use the block id itself as the member so SADD prevents two different users from both adding the same block.
    async function attemptClaim(userId) {
        const member = block; // intentionally not including userId
        // Support both node-redis (sAdd) and upstash (sadd)
        if (client.sAdd) {
            const res = await client.sAdd(soldSetKey, member);
            // if added, record owner separately (optional)
            if (res === 1) {
                try { await client.set && (await client.set(`owner:${tier}:${block}`, userId)); } catch {};
            }
            return res === 1;
        }
        if (client.sadd) {
            const res = await client.sadd(soldSetKey, member);
            if (res === 1) {
                try { await client.set && (await client.set(`owner:${tier}:${block}`, userId)); } catch {};
            }
            return res === 1;
        }
        throw new Error('sadd not supported by client');
    }

    // Run both attempts in parallel
    const p1 = attemptClaim('userA');
    const p2 = attemptClaim('userB');
    const results = await Promise.all([p1, p2]);

    console.log('Attempt results:', results);

    // Check set members
    let members = [];
    if (client.sMembers) members = await client.sMembers(soldSetKey);
    else if (client.smembers) members = await client.smembers(soldSetKey);
    else members = [];
    console.log('Set members after attempts:', members);

    // Now test SETNX/lock approach: try to set a lock per-block
    const lockKey = `block_lock:${tier}:${block}`;
    await client.del(lockKey);
    async function attemptLock(userId) {
        // Support various client APIs for SET NX EX
        if (client.set && typeof client.set === 'function') {
            try {
                // Try node-redis style
                const ok = await client.set(lockKey, userId, { NX: true, EX: 10 });
                return ok === 'OK' || ok === true || ok === '1';
            } catch (e) {
                // Try upstash style
                try {
                    const ok2 = await client.set(lockKey, userId, { nx: true, ex: 10 });
                    return ok2 === true || ok2 === 'OK' || ok2 === 'OK';
                } catch (err) {
                    return false;
                }
            }
        }
        return false;
    }
    const l1 = attemptLock('userA');
    const l2 = attemptLock('userB');
    const lockResults = await Promise.all([l1, l2]);
    console.log('Lock attempt results:', lockResults);
    const lockOwner = await client.get(lockKey);
    console.log('Lock owner:', lockOwner);

    // Cleanup
    await client.del(soldSetKey);
    await client.del(lockKey);
    try {
        if (client.disconnect) await client.disconnect();
        else if (client.quit) await client.quit();
    } catch (e) {
        // ignore disconnect errors for clients that don't support it
    }
})();