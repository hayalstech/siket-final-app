const { Pool } = require('pg');
require('dotenv').config();

/**
 * DATABASE CONNECTION CONFIGURATION
 * We use a Pool to handle multiple users simultaneously.
 * SSL is required for cloud providers like Supabase.
 */
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        // This setting allows the bot to connect to Supabase securely
        rejectUnauthorized: false 
    }
});

/**
 * TEST THE CONNECTION
 * This runs as soon as you start the bot to confirm the 
 * cloud database is reachable.
 */
pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ Cloud Database Connection Error:', err.stack);
    }
    console.log('✅ Connected to Supabase Cloud Database successfully!');
    release();
});

/**
 * GET OR CREATE USER
 * This function checks if a user exists in the 'users' table.
 * If not, it creates a new entry.
 * @param {number} userId - The Telegram User ID
 * @param {string} username - The Telegram Username
 */
async function getUser(userId, username) {
    try {
        // Check if user exists
        const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
        
        if (res.rows.length === 0) {
            // User not found, create a new record
            console.log(`New user detected (${userId}). Registering in cloud database...`);
            const newUser = await pool.query(
                'INSERT INTO users (user_id, username) VALUES ($1, $2) RETURNING *',
                [userId, username]
            );
            return newUser.rows[0];
        }
        
        // Return existing user data
        return res.rows[0];
    } catch (err) {
        console.error("❌ Database Error in getUser function:", err.message);
        throw err;
    }
}

// Export the pool and functions to be used in bot.js
module.exports = { pool, getUser };