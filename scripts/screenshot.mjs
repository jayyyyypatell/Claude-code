/**
 * Render each page and save a screenshot, in both themes and at phone width.
 *
 * A chart validator checks colour, not layout — label collisions, overflow and
 * cramped geometry only show up by looking. This is the "open it and look at
 * it" step, made repeatable.
 *
 * Usage: node scripts/screenshot.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = process.argv[3] ?? "/tmp/shots";
mkdirSync(OUT, { recursive: true });

const PAGES = ["/", "/trends", "/sleep"];
const VIEWPORTS = [
  { name: "desktop", width: 1000, height: 1000 },
  { name: "phone", width: 390, height: 844 },
];

/**
 * The image preinstalled in this environment carries a different Chromium
 * build than the npm package expects, so point Playwright at the binary that
 * is actually here rather than downloading a second copy.
 */
const EXECUTABLE =
  process.env.CHROMIUM_PATH ??
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const browser = await chromium.launch({ executablePath: EXECUTABLE });

for (const theme of ["light", "dark"]) {
  for (const vp of VIEWPORTS) {
    // Skip the phone×dark cross-product for pages where it adds nothing.
    if (vp.name === "phone" && theme === "dark") continue;

    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      colorScheme: theme,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    for (const path of PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      // Give the ResizeObserver a frame to size the charts.
      await page.waitForTimeout(400);
      const slug = path === "/" ? "today" : path.replace(/\//g, "");
      const file = `${OUT}/${slug}-${theme}-${vp.name}.png`;
      await page.screenshot({ path: file, fullPage: true });
      console.log(`  ${file}`);
    }
    await context.close();
  }
}

await browser.close();
console.log("done");
