const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'public');
const port = process.env.PORT || 8081;
const host = '127.0.0.1';

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  let filePath = decodeURIComponent(req.url.split('?')[0]);
  if (filePath === '/' ) filePath = '/index.html';
  const full = path.join(root, filePath);

  // prevent path traversal
  if (!full.startsWith(root)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  fs.stat(full, (err, stat) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    if (stat.isDirectory()) {
      res.statusCode = 302;
      res.setHeader('Location', '/');
      res.end();
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const stream = fs.createReadStream(full);
    stream.pipe(res);
  });
});

server.listen(port, host, () => {
  console.log(`Dev server running at http://${host}:${port}/`);
});

process.on('SIGINT', () => process.exit());
