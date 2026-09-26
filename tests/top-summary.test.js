const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

function appContext(fetch = async () => { throw new Error("offline"); }) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: "", innerHTML: "", className: "", hidden: false,
      replaceChildren() { this.innerHTML = ""; }
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    Intl, console, fetch, localStorage: { getItem: () => JSON.stringify({ accounts: [], holdings: [] }) },
    document: { querySelector: element }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "symbols.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener("click"')), context);
  return { context, element };
}

function snapshot(date, value, isComplete = true) {
  return { date, totalValueJpy: value, isComplete, accounts: [] };
}

test("allocation donut omits the repeated total while retaining legend amounts and percentages", () => {
  const { context, element } = appContext();
  vm.runInContext(`data.holdings = [
    { type: "日本株", currency: "JPY", price: 1, quantity: 10 },
    { type: "米国株", currency: "JPY", price: 1, quantity: 30 },
    { type: "投資信託", currency: "JPY", price: 10000, quantity: 60 }
  ]`, context);
  context.renderAllocation(100);
  const html = element("#allocation").innerHTML;
  assert.match(html, /<small>構成比<\/small>/);
  assert.doesNotMatch(html, /総資産評価額/);
  for (const [name, percent, amount] of [["日本株", "10.0%", 10], ["米国株", "30.0%", 30], ["投資信託", "60.0%", 60]]) {
    assert.ok(html.includes(`<b>${percent}</b><small>${yen.format(amount)}</small>`), `${name} legend stays intact`);
  }
});

test("trend uses the two latest numeric snapshots, including incomplete snapshots", () => {
  const { context, element } = appContext();
  context.renderAssetTrend({ to: "2026-09-26", snapshots: [
    snapshot("2026-09-22", 100), snapshot("2026-09-23", null),
    snapshot("2026-09-24", 150, false), snapshot("2026-09-25", null)
  ] });
  assert.equal(element("#asset-trend-delta").textContent, `+${yen.format(50)}`);
  assert.equal(element("#asset-trend-delta-rate").textContent, "+50.00%");
  assert.equal(element("#asset-trend-delta").className, "positive");
  assert.equal(element("#asset-trend-delta-rate").className, "asset-trend-rate positive");
  assert.match(element("#asset-trend-points").innerHTML, /data-complete="false"/);
  assert.equal(element("#asset-trend-lines").innerHTML, "", "null values still break chart lines");
});

test("trend shows negative, zero, and unavailable comparisons without inventing zero change", () => {
  const { context, element } = appContext();
  const render = snapshots => context.renderAssetTrend({ to: "2026-09-26", snapshots });
  render([snapshot("2026-09-24", 200), snapshot("2026-09-25", 150)]);
  assert.equal(element("#asset-trend-delta").textContent, `-${yen.format(50)}`);
  assert.equal(element("#asset-trend-delta-rate").textContent, "-25.00%");
  assert.equal(element("#asset-trend-delta").className, "negative");
  render([snapshot("2026-09-24", 150), snapshot("2026-09-25", 150)]);
  assert.equal(element("#asset-trend-delta").textContent, yen.format(0));
  assert.equal(element("#asset-trend-delta-rate").textContent, "0.00%");
  assert.equal(element("#asset-trend-delta").className, "");
  render([snapshot("2026-09-24", null), snapshot("2026-09-25", 150)]);
  assert.equal(element("#asset-trend-delta").textContent, "—");
  assert.equal(element("#asset-trend-delta-rate").textContent, "—");
  render([snapshot("2026-09-24", 0), snapshot("2026-09-25", 150)]);
  assert.equal(element("#asset-trend-delta").textContent, `+${yen.format(150)}`);
  assert.equal(element("#asset-trend-delta-rate").textContent, "—", "zero denominator cannot yield a percentage");
  render([]);
  assert.equal(element("#asset-trend-delta").textContent, "—");
  assert.equal(element("#asset-trend-delta-rate").textContent, "—");
  assert.equal(element("#asset-trend-chart").hidden, true);
});

test("TOP keeps the main total and detail link, without a second total in the trend", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /<strong id="total-value">/);
  assert.match(html, /<span id="total-cost">/);
  assert.match(html, /data-trend-details disabled aria-disabled="true"/);
  assert.doesNotMatch(html, /asset-trend-latest|最新の総資産額/);
});
