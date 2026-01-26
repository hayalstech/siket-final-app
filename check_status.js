const { pool } = require('./database');

async function checkTicketStatus() {
    try {
        console.log("Checking ticket status distribution...");
        
        const tiers = [1, 2, 3];
        
        for (const tierId of tiers) {
            // Get current round
            const roundRes = await pool.query("SELECT current_round FROM game_rounds WHERE tier_id = $1", [tierId]);
            const round = roundRes.rows[0]?.current_round;
            
            if (!round) {
                console.log(`Tier ${tierId}: No round info found!`);
                continue;
            }
            
            // Get ticket counts by status
            const res = await pool.query(
                "SELECT status, COUNT(*) as count FROM tickets WHERE tier_id = $1 AND round_no = $2 GROUP BY status", 
                [tierId, round]
            );
            
            console.log(`\nTier ${tierId} (Round ${round}):`);
            if (res.rows.length === 0) {
                console.log("  ⚠️ NO TICKETS FOUND");
            } else {
                res.rows.forEach(r => {
                    console.log(`  - ${r.status}: ${r.count}`);
                });
            }
        }

    } catch (e) {
        console.error("Error:", e);
    } finally {
        process.exit(0);
    }
}

checkTicketStatus();
