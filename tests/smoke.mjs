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
page.on("dialog", (d) => d.accept());
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
page.on("pageerror", (e) => failures.push("page error: " + e.message));

try {
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/`);
  check((await page.textContent("#lib")).includes("still loading"), "roster says the library is still loading");
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 240000 });
  console.log(`runtime ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check(!(await page.$eval("body", (b) => b.classList.contains("loading"))), "loading state clears when the library is listed");
  check((await page.$$("#lib li")).length === 240, "library lists 240 strategies");

  // the template strategy checks clean; a broken one shows the error
  await page.click("#check-btn");
  await page.waitForSelector("#check-state.ok");
  check(await page.$("#smoke svg") !== null, "check draws the smoke tape");
  const saved = await page.evaluate(() => localStorage.getItem("rapoport.strategies"));
  await page.evaluate((v) => { const s = JSON.parse(v); s[0].code = "x = 1"; localStorage.setItem("rapoport.strategies", JSON.stringify(s)); }, saved);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 240000 });
  await page.click("#check-btn");
  await page.waitForSelector("#check-state.bad");
  check((await page.textContent("#check-body")).includes("exactly one"), "a broken strategy shows the Python error");
  await page.evaluate((v) => localStorage.setItem("rapoport.strategies", v), saved);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 240000 });

  // a library strategy copied as a starting point checks clean under its new name
  await page.click('#tabs button[data-tab="source"]');
  await page.waitForFunction(() => document.querySelector(".cm-content").textContent.includes("class TitForTat"));
  await page.click("#copy-source");
  await page.click("#check-btn");
  await page.waitForSelector("#check-state.ok");
  check((await page.textContent("#check-state")).includes("Tit For Tat_copy"), "a copied library strategy checks clean as Tit For Tat_copy");
  await page.click("#delete");
  await page.waitForSelector("#mine li:nth-child(2)", { state: "detached" });

  // exactly three library strategies plus the template
  await page.click("#clear");
  check((await page.$$(".roster input:checked")).length === 0, "clear selection unticks every strategy");
  for (const id of ["TitForTat", "Defector", "Grudger"]) await page.click(`#lib input[data-id="${id}"]`);
  await page.click('#mine input[type="checkbox"]');
  await page.fill('.topbar [data-setting="turns"]', "50");
  await page.fill('.topbar [data-setting="repetitions"]', "2");
  await page.click("#run");
  await page.waitForSelector("#matrix svg", { timeout: 120000 });
  check((await page.$$("#matrix rect.cell")).length === 16, "matrix has 4 x 4 cells");
  check((await page.textContent("#finding")).includes("leads at"), "finding line names the leader");
  check((await page.$$("#tape .strips svg")).length === 2, "tape draws two strips");
  check(!(await page.$eval("#reps-wrap", (e) => e.hidden)), "repetition selector shows for 2 repetitions");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(300);
  check((await page.$eval("#tape .scores span", (e) => e.getBoundingClientRect().right)) <= 768, "tape scores stay in view at 768 wide");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click("#matrix rect.cell[data-i='1'][data-j='2']");
  check((await page.textContent("#tape-title")) !== "", "clicking a cell selects a pairing");
  await page.hover("#matrix rect.cell[data-i='0'][data-j='1']");
  const cellTip = await page.$eval("#tip", (e) => ({ hidden: e.hidden, title: e.querySelector("b").textContent, body: e.querySelector(".doc").textContent }));
  check(!cellTip.hidden && cellTip.title.includes("against") && cellTip.body.includes("a turn for"), "hovering a cell shows a titled tooltip with both payoffs");
  await page.hover("#matrix text[data-tip-title]");
  const nameTip = await page.$eval("#tip .doc", (e) => e.textContent);
  check(nameTip.length > 20 && !nameTip.includes("undefined") && !nameTip.includes("Names:"), "hovering a name shows the docstring's first paragraph");
  await page.mouse.move(0, 0);
  check(await page.$eval("#tip", (e) => e.hidden), "leaving the matrix hides the tooltip");
  // a finger hold shows the same tooltip
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const box = await page.$eval("#matrix rect.cell[data-i='0'][data-j='1']", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
  await page.waitForTimeout(600);
  check(!(await page.$eval("#tip", (e) => e.hidden)), "holding a cell shows the tooltip");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(100);
  check(await page.$eval("#tip", (e) => e.hidden), "lifting the finger hides it");
  await page.focus("#matrix rect.cell[data-i='2'][data-j='0']");
  await page.keyboard.press("Enter");
  check((await page.textContent("#tape-title")).startsWith((await page.$$eval("#mine li span, #lib li span", () => ""), "")) && (await page.$("#matrix rect.cell.on[data-i='2'][data-j='0']")) !== null, "Enter on a focused cell selects it");
  // keyboard order and the folded roster
  const order = await page.evaluate(() => { const ids = []; let el = document.body; for (let k = 0; k < 8; k++) { el = (() => { const all = [...document.querySelectorAll("a, button, input, select, [tabindex='0']")].filter((e) => !e.closest("[inert]") && e.offsetParent !== null && !e.disabled); return all[k]; })(); if (el) ids.push(el.id || el.className || el.tagName); } return ids; });
  check(order.indexOf("run") >= 0 && order.indexOf("run") < 6, "Run is within the first six tabbable controls");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  check(await page.$eval("#roster", (e) => e.inert), "the folded roster is inert while closed");
  check((await page.textContent("#status-sheet")).includes("matches"), "the status shows on the sheet at phone width");
  await page.click("#menu");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(!(await page.$eval("#roster", (e) => e.classList.contains("open"))), "Escape closes the roster");
  await page.setViewportSize({ width: 1440, height: 900 });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  // strategies survive a reload
  await page.click("#new-strategy");
  const names = await page.$$eval("#mine li", (l) => l.length);
  await page.reload();
  await page.waitForSelector("#mine li");
  check((await page.$$eval("#mine li", (l) => l.length)) === names, "user strategies persist across reload");

  // the guide is reachable from the roster and links back
  await page.click('.nav a[href="guide.html"]');
  await page.waitForSelector("h1");
  check((await page.textContent("h1")) === "Guide" && (await page.$('a.btn[href="./"]')) !== null, "guide page opens from the roster and links back to the arena");
  await page.click('a.btn[href="background.html"]');
  await page.waitForSelector("h1");
  check((await page.textContent("h1")) === "Background" && (await page.$("#src-11")) !== null, "background page opens from the guide and carries the sources");
  await page.goto(`http://localhost:${port}/`);

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
