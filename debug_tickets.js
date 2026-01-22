
const { pool } = require('./database');

async function checkStatus() {
    try {
        console.log("Checking database status...");
        
        // Check rounds
        const rounds = await pool.query("SELECT * FROM game_rounds");
        console.log("Game Rounds:", rounds.rows);
        
        for (const round of rounds.rows) {
            const tierId = round.tier_id;
            const roundNo = round.current_round;
            
            // Check ticket count for this round
            const countRes = await pool.query(
                "SELECT COUNT(*) as count FROM tickets WHERE tier_id = $1 AND round_no = $2", 
                [tierId, roundNo]
            );
            const count = parseInt(countRes.rows[0].count);
              console.log(`Tier ${tierId} (Round ${roundNo}): ${count} tickets`);
              
              if (count < 100) {
                console.log(`⚠️ MISSING TICKETS FOR TIER ${tierId} ROUND ${roundNo}! Found ${count}, expected 100. Attempting to fix...`);
                // Insert missing tickets
                for(let n=1; n<=100; n++) {
                  await pool.query(
                    "INSERT INTO tickets (tier_id, number_val, status, round_no) VALUES ($1,$2,'available',$3) ON CONFLICT (tier_id, round_no, number_val) DO NOTHING", 
                    [tierId, n, roundNo]
                  );
                }
                console.log(`✅ Refilled tickets for Tier ${tierId} Round ${roundNo}`);
              }
        }
        
    } catch (e) {
        console.error("Error:", e);
    } finally {
        // Close pool to exit script
        // We need to access the pool from the module, but database.js exports an instance.
        // The pool is not exposed with an .end() method directly if it's just exported as pool.
        // Let's check database.js again.
        process.exit(0);
    }
}

checkStatus();
