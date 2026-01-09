require('dotenv').config();
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { pool, getUser } = require('./database');
const express = require('express');
const multer = require('multer');
const axios = require('axios');

const bot = new Bot(process.env.BOT_TOKEN);
const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// --- API TO TRACK STATUS & WINNERS ---
app.get('/api/status/:tierId', async (req, res) => {
    try {
        const roundRes = await pool.query("SELECT current_round FROM game_rounds WHERE tier_id = $1", [req.params.tierId]);
        const round = roundRes.rows[0].current_round;
        const tickets = await pool.query("SELECT number_val, status FROM tickets WHERE tier_id = $1 AND round_no = $2 ORDER BY number_val ASC", [req.params.tierId, round]);
        
        let winners = { first: 45, second: 12, third: 88 }; // Fetch logic here
        res.json({ round: round, tickets: tickets.rows, soldCount: tickets.rows.filter(t => t.status === 'sold').length, winners });
    } catch (err) { res.status(500).send(err.message); }
});

// --- ADMIN APPROVAL WITH LOGGING ---
bot.callbackQuery(/approve_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tId, num, uId, rnd] = ctx.match;
    await pool.query('UPDATE tickets SET status = $1 WHERE tier_id = $2 AND number_val = $3 AND round_no = $4', ['sold', tId, num, rnd]);
    
    // Log to Admin Chat
    const log = `📑 **ADMIN LOG**\n👤 User: ${ctx.from.first_name}\n🎫 Ticket: #${num}\n🔄 Round: #${rnd}\n📂 Tier: ${tId}`;
    await bot.api.sendMessage(process.env.ADMIN_ID, log);

    // Check if Round Finished
    const count = await pool.query("SELECT count(*) FROM tickets WHERE tier_id = $1 AND status = 'sold' AND round_no = $2", [tId, rnd]);
    if (parseInt(count.rows[0].count) === 100) {
        // BROADCAST WINNER MSG
        const buyers = await pool.query("SELECT DISTINCT owner_id FROM tickets WHERE tier_id = $1 AND round_no = $2", [tId, rnd]);
        for(let b of buyers.rows) {
            await bot.api.sendMessage(b.owner_id, "🎊 ROUND WINNERS ANNOUNCED! Open app for 3D Draw sequence! 🎊");
        }
    }
    await ctx.editMessageCaption({ caption: `✅ Approved #${num}` });
});

bot.command("start", async (ctx) => {
    await getUser(ctx.from.id, ctx.from.username);
    const kb = new InlineKeyboard().webApp("ትኬት ይቁረጡ | Buy Ticket", process.env.WEBAPP_URL);
    ctx.reply(`ሰላም ${ctx.from.first_name}! 👋\nSiket Success Round Active!`, { reply_markup: kb });
});

setInterval(() => { if (process.env.WEBAPP_URL) axios.get(process.env.WEBAPP_URL).catch(() => {}); }, 300000);

app.listen(process.env.PORT || 3000);
bot.start();