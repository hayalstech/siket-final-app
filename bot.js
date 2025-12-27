require('dotenv').config();
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { pool, getUser } = require('./database');
const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');

const bot = new Bot(process.env.BOT_TOKEN);
const app = express();
const upload = multer({ dest: 'uploads/' });

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static('uploads'));

// --- API ROUTES ---
app.get('/api/tickets/:tierId', async (req, res) => {
    try {
        const result = await pool.query('SELECT number_val, status FROM tickets WHERE tier_id = $1 ORDER BY number_val ASC', [req.params.tierId]);
        res.json(result.rows);
    } catch (err) { res.status(500).send("Database Error"); }
});

app.post('/api/reserve', async (req, res) => {
    const { tierId, number, userId } = req.body;
    try {
        const check = await pool.query('SELECT status FROM tickets WHERE tier_id = $1 AND number_val = $2', [tierId, number]);
        if (check.rows[0].status !== 'available') return res.json({ success: false, message: "Taken!" });
        await pool.query('UPDATE tickets SET status = $1, owner_id = $2, reserved_at = NOW() WHERE tier_id = $3 AND number_val = $4', ['reserved', userId, tierId, number]);
        setTimeout(async () => {
            await pool.query("UPDATE tickets SET status = 'available', owner_id = NULL WHERE tier_id = $1 AND number_val = $2 AND status = 'reserved'", [tierId, number]);
        }, 7 * 60 * 1000);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/upload-payment', upload.single('photo'), async (req, res) => {
    const { userId, tierId, number, phone } = req.body;
    const photoPath = req.file.path;
    try {
        await pool.query('UPDATE tickets SET status = $1, screenshot_url = $2, payment_phone = $3 WHERE tier_id = $4 AND number_val = $5', ['pending', photoPath, phone, tierId, number]);
        const keyboard = new InlineKeyboard().text("✅ Approve", `approve_${tierId}_${number}_${userId}`).text("❌ Reject", `reject_${tierId}_${number}_${userId}`);
        await bot.api.sendPhoto(process.env.ADMIN_ID, new InputFile(photoPath), {
            caption: `🔔 New Payment!\nTier: ${tierId}\nNumber: #${number}\nPhone: ${phone}`,
            reply_markup: keyboard
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// --- ADMIN CALLBACKS ---
bot.callbackQuery(/approve_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, num, uId] = ctx.match;
    await pool.query('UPDATE tickets SET status = $1, approved_at = NOW() WHERE tier_id = $2 AND number_val = $3', ['sold', tId, num]);
    await bot.api.sendMessage(uId, `✅ Approved! Number #${num} is yours! 🏆`);
    await ctx.editMessageCaption({ caption: `✅ Approved: Tier ${tId} | #${num}` });
});

bot.callbackQuery(/reject_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, num, uId] = ctx.match;
    await pool.query('UPDATE tickets SET status = $1, owner_id = NULL WHERE tier_id = $2 AND number_val = $3', ['available', tId, num]);
    await bot.api.sendMessage(uId, `❌ Rejected! Receipt error. Try again.`);
    await ctx.editMessageCaption({ caption: `❌ Rejected: Tier ${tId} | #${num}` });
});

// --- THE START COMMAND FIX ---
bot.command("start", async (ctx) => {
    await getUser(ctx.from.id, ctx.from.username);
    // This line uses the Render link from Environment Variables automatically
    const keyboard = new InlineKeyboard().webApp("Open Lottery (ሎተሪ ይግቡ)", process.env.WEBAPP_URL);
    ctx.reply(`ሰላም ${ctx.from.first_name}! 👋\nእንኳን ወደ **ስኬት ሎቶ** በደህና መጡ! 🏆`, { reply_markup: keyboard, parse_mode: "Markdown" });
});

// --- 24/7 KEEP ALIVE PING ---
setInterval(() => {
    if (process.env.WEBAPP_URL) {
        axios.get(process.env.WEBAPP_URL).catch(() => {});
    }
}, 300000); // 5 minutes

app.listen(process.env.PORT || 3000, () => console.log("Siket Lotto Live"));
bot.start();