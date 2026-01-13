require('dotenv').config();
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { pool, getUser } = require('./database');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');

const bot = new Bot(process.env.BOT_TOKEN);
const app = express();
const upload = multer({ dest: 'uploads/' });

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

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
    const { userId, tierId, number, phone, round, fullName } = req.body;
    const tierName = tierId == 3 ? "🥇 GOLD" : tierId == 2 ? "🥈 SILVER" : "🥉 BRONZE";
    
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
    
    await pool.query('UPDATE tickets SET status = $1, owner_id = $2, payment_phone = $3, screenshot_url = $4 WHERE tier_id = $5 AND number_val = $6 AND round_no = $7', 
        ['pending', userId, phone, req.file.path, tierId, number, round]);

    // Store payment request permanently in admin dashboard table
    try {
        await pool.query(`
            INSERT INTO payment_requests (tier_id, ticket_number, round_no, user_id, full_name, phone, screenshot_url, start_time, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
        `, [tierId, number, round, userId, userFullName, phone, req.file.path, startTime]);
    } catch(e) {
        console.error('Error storing payment request:', e);
        // Continue even if table doesn't exist yet - admin can create it
    }

    const keyboard = new InlineKeyboard()
        .text("✅ Approve (አጽድቅ)", `approve_${tierId}_${number}_${userId}_${round}`)
        .text("❌ Reject (ሰርዝ)", `reject_${tierId}_${number}_${userId}_${round}`);

    await bot.api.sendPhoto(process.env.ADMIN_ID, new InputFile(req.file.path), {
        caption: `🔔 **አዲስ ክፍያ**\n\n🔹 **ደረጃ:** ${tierName}\n🔹 **ቁጥር:** #${number}\n🔹 **ዙር:** #${round}\n🔹 **ስልክ:** ${phone}\n🔹 **ስም:** ${userFullName}\n🔹 **ጊዜ:** ${startTimeStr}`,
        reply_markup: keyboard
    });
    res.json({ success: true });
});

// --- ADMIN CALLBACKS ---
bot.callbackQuery(/approve_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, num, uId, rnd] = ctx.match;
    await pool.query('UPDATE tickets SET status = $1 WHERE tier_id = $2 AND number_val = $3 AND round_no = $4', ['sold', tId, num, rnd]);
    
    // Update payment request status
    try {
        await pool.query('UPDATE payment_requests SET status = $1 WHERE tier_id = $2 AND ticket_number = $3 AND round_no = $4 AND user_id = $5', 
            ['approved', tId, num, rnd, uId]);
    } catch(e) {
        console.error('Error updating payment request:', e);
    }
    
    // Check for draw trigger (100 sold)
    const countRes = await pool.query("SELECT count(*) FROM tickets WHERE tier_id = $1 AND status = 'sold' AND round_no = $2", [tId, rnd]);
    if (parseInt(countRes.rows[0].count) === 100) {
        const players = await pool.query("SELECT DISTINCT owner_id FROM tickets WHERE tier_id = $1 AND round_no = $2", [tId, rnd]);
        for(let p of players.rows) {
            await bot.api.sendMessage(p.owner_id, "🔔 ከ3 ደቂቃ በኋላ ዕጣው ይወጣል! መልካም ዕድል!");
        }
        setTimeout(() => runDrawLogic(tId, rnd), 180000); // 3 Mins
    }
    
    // Send approval message (default to Amharic, can be enhanced with language detection)
    await bot.api.sendMessage(uId, `✅ ክፍያዎ ተፈቅዷል! የትኬት ቁጥር: [${num}]። መልካም ዕድል!`);
    await ctx.editMessageCaption({ caption: `✅ Approved Tier ${tId} | #${num}` });
});

// Reject callback
bot.callbackQuery(/reject_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, num, uId, rnd] = ctx.match;
    await pool.query('UPDATE tickets SET status = $1, owner_id = NULL, payment_phone = NULL, screenshot_url = NULL WHERE tier_id = $2 AND number_val = $3 AND round_no = $4', 
        ['available', tId, num, rnd]);
    
    // Update payment request status
    try {
        await pool.query('UPDATE payment_requests SET status = $1 WHERE tier_id = $2 AND ticket_number = $3 AND round_no = $4 AND user_id = $5', 
            ['rejected', tId, num, rnd, uId]);
    } catch(e) {
        console.error('Error updating payment request:', e);
    }
    
    await bot.api.sendMessage(uId, `❌ ክፍያዎ ተቀባይነት አላገኘም። እባክዎ እንደገና ይሞክሩ።`);
    await ctx.editMessageCaption({ caption: `❌ Rejected Tier ${tId} | #${num}` });
});

// Payout confirmation callbacks
bot.callbackQuery(/confirm_payout_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, rnd, num, uId] = ctx.match;
    
    try {
        await pool.query(`
            UPDATE winners_verification 
            SET status = 'paid', paid_at = NOW()
            WHERE tier_id = $1 AND round_no = $2 AND ticket_number = $3 AND user_id = $4
        `, [tId, rnd, num, uId]);
        
        await bot.api.sendMessage(uId, `✅ ሽልማትዎ ተረጋግጧል እና በቅርቡ ወደ አካውንትዎ ይላካል!`);
        await ctx.editMessageCaption({ caption: `✅ Payout Confirmed | Tier ${tId} | Round #${rnd} | Ticket #${num}` });
    } catch(e) {
        console.error('Payout confirmation error:', e);
        await ctx.answerCallbackQuery({ text: 'Error confirming payout', show_alert: true });
    }
});

bot.callbackQuery(/reject_payout_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, rnd, num, uId] = ctx.match;
    
    try {
        await pool.query(`
            UPDATE winners_verification 
            SET status = 'rejected'
            WHERE tier_id = $1 AND round_no = $2 AND ticket_number = $3 AND user_id = $4
        `, [tId, rnd, num, uId]);
        
        await bot.api.sendMessage(uId, `❌ ማረጋገጥዎ ተቀባይነት አላገኘም። እባክዎ ድጋፍ ያግኙ።`);
        await ctx.editMessageCaption({ caption: `❌ Payout Rejected | Tier ${tId} | Round #${rnd} | Ticket #${num}` });
    } catch(e) {
        console.error('Payout rejection error:', e);
        await ctx.answerCallbackQuery({ text: 'Error rejecting payout', show_alert: true });
    }
});

async function runDrawLogic(tId, rnd) {
    const sold = await pool.query("SELECT number_val, owner_id, payment_phone FROM tickets WHERE tier_id = $1 AND status = 'sold' AND round_no = $2", [tId, rnd]);
    let pool_arr = sold.rows;
    let w = [];
    for(let i=0; i<3; i++) w.push(pool_arr.splice(Math.floor(Math.random()*pool_arr.length), 1)[0]);
    
    // Save to History
    await pool.query("INSERT INTO winners_history (tier_id, round_no, w1_num, w2_num, w3_num) VALUES ($1,$2,$3,$4,$5)", [tId, rnd, w[2].number_val, w[1].number_val, w[0].number_val]);

    // Send Admin Log
    await bot.api.sendMessage(process.env.ADMIN_ID, `🏆 **ROUND #${rnd} DRAW COMPLETE**\n1st: #${w[2].number_val}\n2nd: #${w[1].number_val}\n3rd: #${w[0].number_val}`);
    
    // Post winners instantly to Telegram group/channel
    await postWinnersToGroup(tId, rnd, w[2].number_val, w[1].number_val, w[0].number_val);

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
        
        const message = `🎉 **${emoji} ${tierName} TIER - ROUND #${String(roundNo).padStart(4, '0')} WINNERS** 🎉\n\n` +
            `🥇 **1st Place:** Ticket #${firstNum}\n` +
            `🥈 **2nd Place:** Ticket #${secondNum}\n` +
            `🥉 **3rd Place:** Ticket #${thirdNum}\n\n` +
            `🎊 እንኳን ደስ አለዎት አሸናፊዎች! 🎊\n\n` +
            `**${tierNameAm} ደረጃ - ዙር #${String(roundNo).padStart(4, '0')} አሸናፊዎች**\n\n` +
            `🥇 **1ኛ ምድብ:** ትኬት #${firstNum}\n` +
            `🥈 **2ኛ ምድብ:** ትኬት #${secondNum}\n` +
            `🥉 **3ኛ ምድብ:** ትኬት #${thirdNum}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🎯 **Next Round Starting Soon!**\n` +
            `🎯 **የሚቀጥለው ዙር በቅርቡ ይጀምራል!**`;
        
        await bot.api.sendMessage(groupId, message, { parse_mode: 'Markdown' });
        console.log(`✅ Posted winners to ${groupId} for Tier ${tierId}, Round ${roundNo}`);
    } catch (error) {
        console.error('Error posting winners to group:', error);
        // Don't throw - this is not critical for the draw process
    }
}

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
                `**Ticket Number:** #${winner.number}\n` +
                `**Tier:** ${tierName}`;
            
            // Amharic notification
            const messageAm = `🎉 እንኳን ደስ አለዎት! የሲኬት ሎተሪ አሸናፊ ሆነዋል። ሽልማትዎን ለማስተላለፍ እንዲረዳን እባክዎ ሙሉ ስምዎን እና የሚመርጡትን የቴሌብር ወይም የሲቢኢ አካውንት ቁጥር ይላኩልን። ማሳሰቢያ፦ ለማንኛውም ትክክለኛ አካውንት ሽልማቱን ማስተላለፍ ይቻላል። ማሳሰቢያ፦ ለደንበኛ አገልግሎት ሰራተኞች ጉርሻ (ቲፕ) የመስጠት ግዴታ የለብዎትም፤ ጉርሻ መስጠት በፍላጎትዎ ላይ ብቻ የተመሰረተ ነው። ሰራተኞች ጉርሻ እንዲሰጡ ካስገደዱዎት እባክዎ በድረ-ገጹ የቅሬታ/አስተያየት መስጫ ላይ ሪፖርት ያድርጉ።\n\n` +
                `**ምድብ:** ${winner.place === 1 ? '1ኛ' : winner.place === 2 ? '2ኛ' : '3ኛ'} ምድብ\n` +
                `**የትኬት ቁጥር:** #${winner.number}\n` +
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
    
    // Telegram Web Apps work with the base URL - server should serve index.html by default
    // If your server requires /index.html, uncomment the line below
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

// Keep Awake
setInterval(() => { if (process.env.WEBAPP_URL) axios.get(process.env.WEBAPP_URL).catch(() => {}); }, 300000);

app.listen(process.env.PORT || 3000, () => console.log("🌐 Siket Production Server Live"));
bot.start();