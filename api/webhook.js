const serverless = require('serverless-http');
const path = require('path');

// Require the app built in bot.js. bot.js detects Vercel via process.env.VERCEL
// and exports the Express `app` when running in serverless mode.
const app = require(path.join(__dirname, '..', 'bot.js'));

if (!app) {
    module.exports = (req, res) => {
        res.statusCode = 500;
        res.end('Server not initialized');
    };
} else {
    module.exports = serverless(app);
}
