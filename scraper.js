const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const OUTPUT_FILE = path.join(__dirname, 'realized_price_data.json');
const LOG_FILE = path.join(__dirname, 'scraper.log');
const COOKIES_FILE = path.join(__dirname, 'glassnode_cookies.json');
const HEADLESS = process.env.SCRAPER_HEADLESS !== 'false';

const TARGETS = [
  { symbol: 'BTC', url: 'https://studio.glassnode.com/charts/market.PriceRealizedUsd?a=BTC' },
  { symbol: 'ETH', url: 'https://studio.glassnode.com/charts/market.PriceRealizedUsd?a=ETH' },
  { symbol: 'SOL', url: 'https://studio.glassnode.com/charts/market.PriceRealizedUsd?a=SOL' },
  { symbol: 'XRP', url: 'https://studio.glassnode.com/charts/market.PriceRealizedUsd?a=XRP' },
];

// Bu script Glassnode Studio'nun canlı DOM'una erişim olmadan yazıldı.
// Selector'lar tahmine dayalı yedek stratejiler içeriyor - ilk çalıştırmadan
// önce mutlaka `npm run debug` ile kalibre et (bkz. README "Selector'ları
// kalibre et" bölümü).
const SELECTORS = {
  latestValueCard: [
    '[class*="latestValueCard"]',
    '[class*="LatestValueCard"]',
    '[data-testid="latest-value-card"]',
    '[class*="latest-value"]',
    '[class*="LatestValue"]',
  ],
  loginWallIndicators: [
    'text/Log in',
    'text/Sign in',
    '[class*="LoginModal"]',
    '[class*="loginWall"]',
    '[class*="AuthModal"]',
  ],
};

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function parseDollarValue(rawText) {
  if (!rawText) return null;
  const cleaned = rawText.replace(/,/g, '');
  const match = cleaned.match(/-?\$?\s*([\d]+(\.\d+)?)/);
  if (!match) return null;
  return parseFloat(match[1]);
}

async function loadCookies(page) {
  if (!fs.existsSync(COOKIES_FILE)) {
    log('UYARI: glassnode_cookies.json bulunamadı. Oturumsuz istek yapılacak, ' +
      'Studio muhtemelen login duvarı gösterecek ve değer okunamayacak.');
    return;
  }
  try {
    const raw = fs.readFileSync(COOKIES_FILE, 'utf-8');
    const cookies = JSON.parse(raw);
    await page.setCookie(...cookies);
    log(`Cookie dosyası yüklendi (${cookies.length} cookie).`);
  } catch (err) {
    log(`Cookie dosyası okunamadı/parse edilemedi: ${err.message}`);
  }
}

async function detectLoginWall(page) {
  for (const sel of SELECTORS.loginWallIndicators) {
    try {
      if (sel.startsWith('text/')) {
        const text = sel.slice(5);
        const found = await page.evaluate((t) => document.body.innerText.includes(t), text);
        if (found) return true;
      } else {
        const el = await page.$(sel);
        if (el) return true;
      }
    } catch (_) {
      // sıradaki gösterge denenir
    }
  }
  return false;
}

async function findLatestValueText(page) {
  for (const sel of SELECTORS.latestValueCard) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      const text = await page.$eval(sel, (el) => el.innerText || el.textContent);
      if (text && text.trim().length > 0) return text.trim();
    } catch (_) {
      // sıradaki selector denenir
    }
  }
  return null;
}

async function scrapeOne(browser, target) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await loadCookies(page);

  const result = {
    symbol: target.symbol,
    url: target.url,
    date: todayUTC(),
    scraped_at_utc: null,
    latest_value_raw_text: null,
    realized_price_usd: null,
    login_wall_detected: false,
    error: null,
  };

  try {
    await page.goto(target.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 3000)); // kartların render olmasını bekle

    result.login_wall_detected = await detectLoginWall(page);
    if (result.login_wall_detected) {
      log(`${target.symbol}: login duvarı tespit edildi, değer okunamayabilir. Cookie'leri yenilemen gerekebilir.`);
    }

    const rawText = await findLatestValueText(page);
    result.latest_value_raw_text = rawText;
    result.realized_price_usd = parseDollarValue(rawText);
    result.scraped_at_utc = new Date().toISOString();

    if (result.realized_price_usd === null) {
      log(`${target.symbol}: değer okunamadı - SELECTORS.latestValueCard'ı kalibre et (npm run debug).`);
    } else {
      log(`${target.symbol}: $${result.realized_price_usd}`);
    }
  } catch (err) {
    result.error = err.message;
    log(`${target.symbol}: HATA - ${err.message}`);
  } finally {
    await page.close();
  }

  return result;
}

function appendResults(runEntry) {
  let data = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
      if (!Array.isArray(data)) data = [];
    } catch (_) {
      data = [];
    }
  }
  // data.push(runEntry); // sadece bugunun verisi
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify([runEntry], null, 2));
}

async function run() {
  log(`Çalıştırma başladı (headless=${HEADLESS})`);
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const results = [];
  for (const target of TARGETS) {
    const r = await scrapeOne(browser, target);
    results.push(r);
  }

  await browser.close();

  const runEntry = {
    run_timestamp_utc: new Date().toISOString(),
    results,
  };
  appendResults(runEntry);
  log('Çalıştırma tamamlandı, realized_price_data.json güncellendi.');

  return runEntry;
}

if (require.main === module) {
  run().catch((err) => {
    log(`Beklenmeyen hata: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { run };
