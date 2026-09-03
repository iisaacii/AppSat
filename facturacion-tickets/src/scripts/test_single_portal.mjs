import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const url = process.argv[2];
if (!url) {
  console.error("Please provide a URL to test as the first argument.");
  process.exit(1);
}

const screenshotPath = resolve("scratch/test_screenshot.png");

async function main() {
  console.log(`Testing URL: ${url}`);
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-http2"
    ]
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true
  });

  const page = await context.newPage();

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    console.log("Waiting 5 seconds for page load/JS execution...");
    await page.waitForTimeout(5000);

    const title = await page.title();
    const finalUrl = page.url();
    const status = response ? response.status() : "N/A";

    console.log(`- Status: ${status}`);
    console.log(`- Title: ${title}`);
    console.log(`- Final URL: ${finalUrl}`);

    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    console.log(`- Body length: ${bodyText.length}`);
    console.log(`- Snippet: ${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`);

    await page.screenshot({ path: screenshotPath });
    console.log(`- Saved screenshot to ${screenshotPath}`);

  } catch (err) {
    console.error("- Navigation error:", err.message);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
