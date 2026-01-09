require('dotenv').config();
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { pool, getUser } = require('./database');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');

// Initialize variables ONCE
const bot = new Bot(process.env.BOT_TOKEN);
const app = express();
const upload = multer({ dest: 'uploads/' });

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// FIX FOR BUTTON: Using web_app type for "ትኬት ይቁረጡ"
bot.command("start", async (ctx) => {
    await getUser(ctx.from.id, ctx.from.username);
    const keyboard = new InlineKeyboard()
        .webApp("ትኬት ይቁረጡ | Buy Ticket", process.env.WEBAPP_URL)
        .row()
        .url("ያግኙን (Contact Center)", "https://t.me/Contact_Siketlottery");

    await ctx.reply(`ሰላም ${ctx.from.first_name}! 👋\nእንኳን ወደ ስኬት ሎቶ በደህና መጡ!`, { 
        reply_markup: keyboard, 
        parse_mode: "Markdown" 
    });
});

// Admin Approval with Logging
bot.callbackQuery(/approve_(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
    const [_, tierId, num, uId, rnd] = ctx.match;
    await pool.query('UPDATE tickets SET status = $1 WHERE tier_id = $2 AND number_val = $3 AND round_no = $4', ['sold', tierId, num, rnd]);
    
    // FETCH LOG DATA
    const ticket = await pool.query('SELECT * FROM tickets WHERE tier_id=$1 AND number_val=$2 AND round_no=$3', [tierId, num, rnd]);
    
    const log = `✅ **APPROVED SALE**\n👤 Name: ${ctx.from.first_name}\n📞 Phone: ${ticket.rows[0].payment_phone}\n🎫 Number: #${num}\n🔄 Round: #${rnd}`;
    await bot.api.sendMessage(process.env.ADMIN_ID, log);
    
    await ctx.editMessageCaption({ caption: `✅ Approved Tier ${tierId} | #${num}` });
});

setInterval(() => { if (process.env.WEBAPP_URL) axios.get(process.env.WEBAPP_URL).catch(() => {}); }, 300000);

app.listen(process.env.PORT || 3000);
bot.start();