// Browser smoke test: serve the folder, wait for the runtime, run a small
// tournament and check the results render. Then reload offline and check the
// service worker serves the page and the runtime from its cache.
//
//   node tests/smoke.mjs            (needs Chromium; set CHROME_PATH to override)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8000 + Math.floor(Math.random() * 1000);
const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const executablePath = process.env.CHROME_PATH || path.join(process.env.HOME, ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");

const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
page.on("pageerror", (e) => failures.push("page error: " + e.message));

try {
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 240000 });
  console.log(`runtime ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check((await page.$$("#lib li")).length === 240, "library lists 240 strategies");

  // the template strategy checks clean; a broken one shows the error
  await page.click("#check-btn");
  await page.waitForSelector("#check-state.ok");
  check(await page.$("#smoke svg") !== null, "check draws the smoke tape");
  const saved = await page.evaluate(() => localStorage.getItem("rapoport.strategies"));
  await page.evaluate(() => { const v = document.querySelector(".cm-content"); v.textContent = "x = 1"; v.dispatchEvent(new Event("input")); });
  await page.waitForTimeout(400);
  await page.click("#check-btn");
  await page.waitForSelector("#check-state.bad");
  check((await page.textContent("#check-body")).includes("exactly one"), "a broken strategy shows the Python error");
  await page.evaluate((v) => localStorage.setItem("rapoport.strategies", v), saved);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 240000 });

  // exactly three library strategies plus the template
  await page.evaluate(() => { for (const c of document.querySelectorAll('#lib input:checked')) c.click(); });
  for (const id of ["TitForTat", "Defector", "Grudger"]) await page.click(`#lib input[data-id="${id}"]`);
  await page.fill('.topbar [data-setting="turns"]', "50");
  await page.fill('.topbar [data-setting="repetitions"]', "2");
  await page.click("#run");
  await page.waitForSelector("#matrix svg", { timeout: 120000 });
  check((await page.$$("#matrix rect.cell")).length === 16, "matrix has 4 x 4 cells");
  check((await page.textContent("#finding")).includes("leads at"), "finding line names the leader");
  check((await page.$$("#tape .row svg")).length === 2, "tape draws two rows");
  check(!(await page.$eval("#reps", (e) => e.hidden)), "repetition selector shows for 2 repetitions");
  await page.click("#matrix rect.cell[data-i='1'][data-j='2']");
  check((await page.textContent("#tape-title")) !== "", "clicking a cell selects a pairing");

  // strategies survive a reload
  await page.click("#new-strategy");
  const names = await page.$$eval("#mine li", (l) => l.length);
  await page.reload();
  await page.waitForSelector("#mine li");
  check((await page.$$eval("#mine li", (l) => l.length)) === names, "user strategies persist across reload");

  // offline: the shell and the runtime come from the service worker cache
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 240000 });
  await context.setOffline(true);
  const t1 = Date.now();
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 120000 });
  console.log(`offline reload ready in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  check(true, "page loads and the runtime starts with the network off");
} catch (e) {
  failures.push(e.message);
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error("\nFailed:\n  " + failures.join("\n  ")); process.exit(1); }
console.log("\nall checks passed");
