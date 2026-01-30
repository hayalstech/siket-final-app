const fs = require('fs');
const html = fs.readFileSync('public/index.html','utf8');
const scripts = [];
let regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = regex.exec(html)) !== null) {
  const tag = m[0];
  // skip external scripts with src attribute
  if (/\ssrc=/.test(tag)) continue;
  scripts.push(m[1]);
}
const combined = scripts.join('\n\n// --- script boundary ---\n\n');
try {
  new Function(combined);
  console.log('No syntax errors detected in inline scripts');
} catch (e) {
  console.error('Syntax error detected:', e.message);
  console.error(e.stack);
}
// Narrow down which script block fails
for (let i = 0; i < scripts.length; i++) {
  try {
    new Function(scripts[i]);
  } catch (e) {
    console.error(`Script block ${i} has syntax error:`, e.message);
    break;
  }
}
