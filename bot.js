const axios = require('axios');
require('dotenv').config();
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { pool, getUser } = require('./database');
const express = require('express');
const multer = require('multer');
const fs = require('fs');

const bot = new Bot(process.env.BOT_TOKEN);
const app = express();
const upload = multer({ dest: 'uploads/' });

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// API to get Tier Data, Prizes, and current Round
app.get('/api/status/:tierId', async (req, res) => {
    try {
        const roundRes = await pool.query("SELECT current_round FROM game_rounds WHERE id = 1");
        const round = roundRes.rows[0].current_round;
        const tierRes = await pool.query("SELECT * FROM tiers WHERE id = $1", [req.params.tierId]);
        const ticketsRes = await pool.query("SELECT number_val, status FROM tickets WHERE tier_id = $1 AND round_no = $2 ORDER BY number_val ASC", [req.params.tierId, round]);
        res.json({ round: round, prizes: tierRes.rows[0], tickets: ticketsRes.rows });
    } catch (err) { res.status(500).send(err.message); }
});

// Reservation and Upload Payment
app.post('/api/upload-payment', upload.single('photo'), async (req, res) => {
    const { userId, tierId, number, phone, round } = req.body;
    const tierName = tierId == 3 ? "🥇 Gold" : tierId == 2 ? "🥈 Silver" : "🥉 Bronze";
    
    // Save as pending in DB
    await pool.query('UPDATE tickets SET status = $1, owner_id = $2, payment_phone = $3, screenshot_url = $4 WHERE tier_id = $5 AND number_val = $6 AND round_no = $7', 
        ['pending', userId, phone, req.file.path, tierId, number, round]);

    const keyboard = new InlineKeyboard()
        .text("✅ Approve", `approve_${tierId}_${number}_${userId}_${round}`)
        .text("❌ Reject", `reject_${tierId}_${number}_${userId}_${round}`);

    await bot.api.sendPhoto(process.env.ADMIN_ID, new InputFile(req.file.path), {
        caption: `🔔 **New Request!**\nType: ${tierName}\nNumber: #${number}\nRound: ${round}\nPhone: ${phone}`,
        reply_markup: keyboard
    });
    res.json({ success: true });
});

bot.callbackQuery(/approve_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, num, uId, rnd] = ctx.match;
    await pool.query('UPDATE tickets SET status = $1 WHERE tier_id = $2 AND number_val = $3 AND round_no = $4', ['sold', tId, num, rnd]);
    
    // Check if 100 tickets sold
    const count = await pool.query("SELECT count(*) FROM tickets WHERE tier_id = $1 AND status = 'sold' AND round_no = $2", [tId, rnd]);
    if (parseInt(count.rows[0].count) === 100) {
        // Send global message
        await bot.api.sendMessage(uId, "ሁሉም ቲኬቶች ተሽጠዋል! በ 5 ደቂቃ ውስጥ ዕጣው ይወጣል።");
        // Trigger draw function here
    }
    await ctx.editMessageCaption({ caption: `✅ Approved Tier ${tId} | #${num}` });
});

bot.command("start", async (ctx) => {
    await getUser(ctx.from.id, ctx.from.username);
    
    const welcome = `ሰላም ${ctx.from.first_name}! 👋\nእንኳን ወደ **ስኬት ሎተሪ (Siket Lottery)** በደህና መጡ! 🏆\n\nእድልዎን ለመሞከር አሁኑኑ ቲኬት ይቁረጡ።`;
    
    const keyboard = new InlineKeyboard()
        .webApp("ትኬት ይቁረጡ | Buy Ticket", process.env.WEBAPP_URL) // Opens the App
        .row()
        .url("በመረጃ ማዕከል ይግዙ | Buy via Contact", "https://t.me/Contact_Siketlottery") // New Option
        .row()
        .text("ስለ እኛ (About Us)", "about_us");

    await ctx.reply(welcome, { reply_markup: keyboard, parse_mode: "Markdown" });
});

app.listen(process.env.PORT || 3000);
bot.start();
// KEEP-ALIVE: Pings the server every 5 minutes to prevent sleeping
const RENDER_URL = "https://siket-final-app.onrender.com"; // Your Render link
setInterval(() => {
    axios.get(RENDER_URL)
        .then(() => console.log("Heartbeat: Siket is Awake! 🏆"))
        .catch((err) => console.log("Heartbeat failed, but server is likely active."));
}, 300000); // 300,000ms = 5 minutes