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

// --- API: Upload Payment ---
app.post('/api/upload-payment', upload.single('photo'), async (req, res) => {
    const { userId, tierId, number, phone, round } = req.body;
    const tierName = tierId == 3 ? "🥇 GOLD" : tierId == 2 ? "🥈 SILVER" : "🥉 BRONZE";
    
    // Get user info from Telegram
    let fullName = 'Unknown User';
    try {
        const userInfo = await bot.api.getChat(userId);
        fullName = userInfo.first_name + (userInfo.last_name ? ' ' + userInfo.last_name : '');
    } catch(e) {
        console.error('Error fetching user info:', e);
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
        `, [tierId, number, round, userId, fullName, phone, req.file.path, startTime]);
    } catch(e) {
        console.error('Error storing payment request:', e);
        // Continue even if table doesn't exist yet - admin can create it
    }

    const keyboard = new InlineKeyboard()
        .text("✅ Approve (አጽድቅ)", `approve_${tierId}_${number}_${userId}_${round}`)
        .text("❌ Reject (ሰርዝ)", `reject_${tierId}_${number}_${userId}_${round}`);

    await bot.api.sendPhoto(process.env.ADMIN_ID, new InputFile(req.file.path), {
        caption: `🔔 **አዲስ ክፍያ (New Request)**\n\n🔹 **League:** ${tierName}\n🔹 **Number:** #${number}\n🔹 **Round:** #${round}\n🔹 **Phone:** ${phone}\n🔹 **Name:** ${fullName}\n🔹 **Time:** ${startTimeStr}`,
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
            await bot.api.sendMessage(p.owner_id, "🔔 After 3 minutes the draw will start. Good Luck! / ከ3 ደቂቃ በኋላ ዕጣው ይወጣል! መልካም ዕድል!");
        }
        setTimeout(() => runDrawLogic(tId, rnd), 180000); // 3 Mins
    }
    
    // Send bilingual approval message
    await bot.api.sendMessage(uId, `✅ Your payment is approved! Ticket Number: [${num}]. Good Luck! / ክፍያዎ ተፈቅዷል! የትኬት ቁጥር: [${num}]። መልካም ዕድል!`);
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
    
    await bot.api.sendMessage(uId, `❌ Your payment was rejected. Please try again. / ክፍያዎ ተቀባይነት አላገኘም። እባክዎ እንደገና ይሞክሩ።`);
    await ctx.editMessageCaption({ caption: `❌ Rejected Tier ${tId} | #${num}` });
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

    // Increment and Reset
    let nextR = parseInt(rnd) + 1;
    if(nextR > 1000) nextR = 1;
    await pool.query("UPDATE game_rounds SET current_round = $1 WHERE tier_id = $2", [nextR, tId]);
    for(let n=1; n<=100; n++) await pool.query("INSERT INTO tickets (tier_id, number_val, status, round_no) VALUES ($1,$2,'available',$3)", [tId, n, nextR]);
}

bot.command("start", async (ctx) => {
    await getUser(ctx.from.id, ctx.from.username);
    const kb = new InlineKeyboard().webApp("ትኬት ይቁረጡ | Buy Ticket", process.env.WEBAPP_URL).row().url("በመረጃ ማዕከል ይግዙ", "https://t.me/Contact_Siketlottery");
    ctx.reply(`ሰላም ${ctx.from.first_name}! 👋\nእንኳን ወደ ስኬት ሎቶ በደህና መጡ!`, { reply_markup: kb });
});

// Keep Awake
setInterval(() => { if (process.env.WEBAPP_URL) axios.get(process.env.WEBAPP_URL).catch(() => {}); }, 300000);

app.listen(process.env.PORT || 3000, () => console.log("🌐 Siket Production Server Live"));
bot.start();