import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const projectRoot = resolve(__dirname, "../..");
const hashmapPath = resolve(projectRoot, "data/portal-url-directory-hashmap.json");
const localScreenshotDir = resolve(projectRoot, "artifacts/portal-screenshots");
const brainScreenshotDir = "scratch/portal-screenshots";
const reportPath = resolve(projectRoot, "artifacts/portal-verification-report.json");

// Billing keywords to scan in page title & body text
const KEYWORDS = [
  "factura",
  "facturar",
  "facturacion",
  "facturación",
  "rfc",
  "cfdi",
  "folio",
  "ticket",
  "comprobante",
  "boleta",
  "emision",
  "emisión",
  "billing"
];

async function main() {
  console.log("=== Starting Playwright UI Portal Audit ===");

  // Ensure directories exist
  await fs.mkdir(localScreenshotDir, { recursive: true });
  try {
    await fs.mkdir(brainScreenshotDir, { recursive: true });
  } catch (err) {
    console.warn("Could not create brain screenshot directory, will skip copying there:", err.message);
  }

  // Load portals
  let data;
  try {
    const raw = await fs.readFile(hashmapPath, "utf8");
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read hashmap from ${hashmapPath}:`, err);
    process.exit(1);
  }

  // Parse command line arguments
  const args = process.argv.slice(2);
  let keysToAudit = [];
  const keysArgIndex = args.indexOf("--keys");
  if (keysArgIndex !== -1 && args[keysArgIndex + 1]) {
    keysToAudit = args[keysArgIndex + 1].split(",").map(k => k.trim());
  }

  let entries = Object.entries(data).map(([key, value]) => ({
    key, // RFC or identifier
    ...value
  }));

  if (keysToAudit.length > 0) {
    entries = entries.filter(e => keysToAudit.includes(e.key));
    console.log(`Filtering audit to only keys: ${keysToAudit.join(", ")}`);
  }

  console.log(`Loaded ${entries.length} portals to audit.`);

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process"
    ]
  });

  const results = [];
  const limit = 2; // Process 2 pages concurrently

  // Helper to run tasks with concurrency limit
  async function runWithConcurrency(items, limit, fn) {
    const activePromises = [];
    for (const item of items) {
      if (activePromises.length >= limit) {
        await Promise.race(activePromises);
      }
      const p = fn(item).then((res) => {
        results.push(res);
        activePromises.splice(activePromises.indexOf(p), 1);
      });
      activePromises.push(p);
    }
    await Promise.all(activePromises);
  }

  // Worker task with built-in retry
  async function auditPortal(entry) {
    const { key, nombreComercial, portalFacturacionUrl } = entry;
    console.log(`[START] [${nombreComercial}] - ${portalFacturacionUrl}`);

    let attempt = 0;
    const maxAttempts = 3;
    let lastError = null;

    const result = {
      key,
      nombreComercial,
      originalUrl: portalFacturacionUrl,
      finalUrl: null,
      statusCode: null,
      statusText: null,
      title: null,
      loadSuccess: false,
      keywordsFound: [],
      error: null,
      screenshotName: `${key}.png`
    };

    while (attempt < maxAttempts) {
      attempt++;
      if (attempt > 1) {
        console.log(`[RETRY ${attempt}/${maxAttempts}] [${nombreComercial}] - Waiting 3s before retry...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true
      });

      const page = await context.newPage();

      try {
        // 35 second timeout
        const response = await page.goto(portalFacturacionUrl, {
          waitUntil: "domcontentloaded",
          timeout: 35000
        });

        // Wait a bit for JS execution / rendering
        await page.waitForTimeout(3000);

        result.loadSuccess = true;
        result.finalUrl = page.url();
        result.title = await page.title();

        if (response) {
          result.statusCode = response.status();
          result.statusText = response.statusText();
        }

        // Scan page content
        const bodyText = await page.evaluate(() => document.body?.innerText || "");
        const titleText = result.title || "";
        const combinedText = (titleText + " " + bodyText).toLowerCase();

        result.keywordsFound = KEYWORDS.filter(kw => combinedText.includes(kw));

        // Take screenshot
        const localPath = resolve(localScreenshotDir, `${key}.png`);
        const brainPath = resolve(brainScreenshotDir, `${key}.png`);

        await page.screenshot({ path: localPath, type: "png" });

        // Copy to brain directory if we can
        try {
          await fs.copyFile(localPath, brainPath);
        } catch (err) {
          // Ignore copy errors if brain dir is not writable
        }

        console.log(
          `[SUCCESS] [${nombreComercial}] - status: ${result.statusCode}, keywords: [${result.keywordsFound.join(", ")}]`
        );

        result.error = null;
        await context.close();
        break;
      } catch (err) {
        lastError = err.message;
        result.loadSuccess = false;
        console.log(`[ATTEMPT ${attempt} FAILED] [${nombreComercial}] - Error: ${err.message}`);

        // Try to take screenshot of whatever is there
        try {
          const localPath = resolve(localScreenshotDir, `${key}.png`);
          const brainPath = resolve(brainScreenshotDir, `${key}.png`);
          await page.screenshot({ path: localPath, type: "png" });
          await fs.copyFile(localPath, brainPath);
        } catch (screenshotErr) {
          // Ignore screenshot failure
        }
      } finally {
        await context.close();
      }
    }

    if (!result.loadSuccess) {
      result.error = lastError;
      console.log(`[PERMANENT FAILURE] [${nombreComercial}] - Final Error: ${lastError}`);
    }

    return result;
  }

  // Execute
  await runWithConcurrency(entries, limit, auditPortal);

  // Close browser
  await browser.close();

  // Write report (merging with existing if present)
  let existingReport = { total: 0, successCount: 0, failureCount: 0, keywordMatchCount: 0, results: [] };
  try {
    const rawReport = await fs.readFile(reportPath, "utf8");
    existingReport = JSON.parse(rawReport);
  } catch (err) {
    console.warn("Could not load existing report for merging, will write a brand new one:", err.message);
  }

  // Merge results: replace entries in existingReport with new results, or add them if not present
  const mergedResultsMap = new Map();
  if (existingReport && Array.isArray(existingReport.results)) {
    for (const r of existingReport.results) {
      mergedResultsMap.set(r.key, r);
    }
  }
  for (const r of results) {
    mergedResultsMap.set(r.key, r);
  }

  const finalResultsList = Array.from(mergedResultsMap.values()).sort((a, b) =>
    a.nombreComercial.localeCompare(b.nombreComercial)
  );

  const summary = {
    total: finalResultsList.length,
    successCount: finalResultsList.filter(r => r.loadSuccess).length,
    failureCount: finalResultsList.filter(r => !r.loadSuccess).length,
    keywordMatchCount: finalResultsList.filter(r => r.keywordsFound.length > 0).length,
    results: finalResultsList
  };

  await fs.writeFile(reportPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n=== Verification Report Saved to ${reportPath} ===`);
  console.log(`Summary: Total: ${summary.total}, Loaded: ${summary.successCount}, Failed: ${summary.failureCount}, Keywords Found: ${summary.keywordMatchCount}`);
}

main().catch(console.error);
