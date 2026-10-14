import { existsSync } from "node:fs";
import { chromium } from "playwright";
const SHOTS = process.env.SHOTS, BASE = "http://127.0.0.1:3000";
const browser = await chromium.launch({ executablePath: ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(p => existsSync(p)) });
const page = await (await browser.newContext({ locale: "pl-PL", viewport: { width: 1280, height: 1000 } })).newPage();
const errors = []; page.on("pageerror", e => errors.push(String(e)));
page.on("dialog", d => d.accept());
const api = (path, method = "GET", body) => page.evaluate(async ({ path, method, body }) => {
  const s = await (await fetch("/api/session")).json();
  const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-cashflow-csrf-token": s.csrfToken || "", "x-cashflow-budget-id": localStorage.getItem("cashflow_budget_id") || "" }, body: body && JSON.stringify(body) });
  return r.status;
}, { path, method, body });
const english = /\b(the|and|with|your|this|Period|Settings|Save|Add|Delete|Edit|Show|Funding|Goal|Flex|requested|budget|currency|pending|active|funded|underfunded|viewer|owner|Validate|Regenerate|Theme|Density)\b/;
async function scan(name) {
  await page.waitForTimeout(700);
  const text = await page.locator("body").innerText();
  const hits = text.split("\n").map(l => l.trim()).filter(l => l && english.test(l) && !/Sample|owner\b.*·|^owner$/.test(l));
  console.log(`[${name}] english-looking lines:`, hits.slice(0, 8));
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
await page.goto(`${BASE}/`);
await page.locator("#beta-create-account-id").fill("owner");
await page.locator("button[type=submit]").first().click();
await page.locator(".beta-entry-choice", { hasText: "owner" }).click();
await page.locator("#beta-setup-opening").fill("1000");
await page.locator("form button[type=submit]").last().click();
await page.locator(".beta-topbar").waitFor();
await api("/api/import/sample", "POST", {}); await api("/api/settings", "PUT", { locale: "pl" });
await page.reload(); await page.locator(".beta-topbar").waitFor();
await scan("ledger");
for (const [nav, name] of [[1, "recurring"], [2, "oneoff"], [3, "priorities"], [4, "targets"], [5, "budget"]]) {
  await page.locator(".beta-section-btn").nth(nav).click(); await scan(name);
}
await page.locator(".beta-user-menu-trigger").click(); await scan("menu");
await page.locator("[role=menuitem]").nth(2).click(); await scan("settings");
console.log("page errors:", errors);
await browser.close();
