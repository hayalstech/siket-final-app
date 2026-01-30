const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

(async () => {
  const outDir = path.resolve(__dirname);
  const outImg = path.join(outDir, 'headless_screenshot.png');
  const url = process.env.URL || 'http://localhost:8081';

  console.log('Opening', url);
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => {
      console.log('PAGE ERROR:', err.toString());
      if (err.stack) console.log(err.stack);
    });
    page.on('response', resp => {
      if (resp.status() >= 400) console.log('BAD RESPONSE', resp.status(), resp.url());
    });

    await page.setViewport({ width: 1200, height: 400 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    // wait a bit for animations
    await new Promise(res => setTimeout(res, 1500));

    // take screenshot
    await page.screenshot({ path: outImg, fullPage: false });
    console.log('Saved screenshot to', outImg);

    // capture some DOM checks
    const heroVisible = await page.$eval('.hero-trust-title', el => {
      const rect = el.getBoundingClientRect();
      return { text: el.innerText, w: rect.width, h: rect.height };
    }).catch(e => null);

    console.log('Hero element check:', heroVisible);
  } catch (e) {
    console.error('Headless check error:', e);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
