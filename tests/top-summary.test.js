const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const jpyNumber = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const yen = amount => `${jpyNumber.format(amount)}円`;

function appContext(fetch = async () => { throw new Error("offline"); }) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      textContent: "", innerHTML: "", className: "", hidden: false,
      attributes: new Set(),
      setAttribute(name) { this.attributes.add(name); },
      toggleAttribute(name, enabled) { if (enabled) this.attributes.add(name); else this.attributes.delete(name); },
      hasAttribute(name) { return this.attributes.has(name); },
      replaceChildren() { this.innerHTML = ""; }
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    Intl, console, fetch, localStorage: { getItem: () => JSON.stringify({ accounts: [], holdings: [] }) },
    document: {
      querySelector: element,
      createElement: () => {
        let textContent = "";
        return { set textContent(value) { textContent = String(value); }, get innerHTML() {
          return textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
        } };
      }
    }
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
    assert.ok(html.includes(`<b>${percent}</b><small>${yen(amount)}</small>`), `${name} legend stays intact`);
  }
});

test("asset weather uses seven centralized day-rate thresholds and hides invalid rates", () => {
  const { context, element } = appContext();
  for (const [rate, expected] of [
    [5, "special"], [4.99, "very-sunny"], [3, "very-sunny"], [2.99, "sunny"],
    [0.5, "sunny"], [0.49, "partly-cloudy"], [-0.5, "partly-cloudy"],
    [-0.51, "cloud"], [-2.99, "cloud"], [-3, "rain"], [-5, "rain"], [-5.01, "storm"]
  ]) assert.equal(context.getAssetWeatherState(rate), expected, `${rate}% maps to ${expected}`);
  for (const rate of [null, undefined, NaN, Infinity, "5"]) assert.equal(context.getAssetWeatherState(rate), null);

  context.renderAssetWeatherIcon(3.5);
  assert.equal(element("#asset-weather-icon").src, "/assets/icons/asset-weather-very-sunny.svg");
  assert.equal(element("#asset-weather-icon").alt, "資産天気: 強い晴れ");
  assert.equal(element("#asset-weather-icon").hidden, false);
  context.renderAssetWeatherIcon(null);
  assert.equal(element("#asset-weather-icon").hidden, true);
  assert.equal(element("#asset-weather-icon").alt, "");
});

test("trend renders incomplete values and does not connect across null snapshots", () => {
  const { context, element } = appContext();
  context.renderAssetTrend({ to: "2026-09-26", snapshots: [
    snapshot("2026-09-22", 100), snapshot("2026-09-23", null),
    snapshot("2026-09-24", 150, false), snapshot("2026-09-25", null)
  ] });
  assert.match(element("#asset-trend-points").innerHTML, /data-complete="false"/);
  assert.equal(element("#asset-trend-lines").innerHTML, "", "null values still break chart lines");
  assert.equal(element("#asset-trend-chart").hidden, false, "a valued incomplete snapshot remains visible");
});

test("trend renders two snapshots as a connected area chart and handles 0 or 1 usable values", () => {
  const { context, element } = appContext();
  const render = snapshots => context.renderAssetTrend({ to: "2026-09-26", snapshots });
  element("#asset-trend-chart").setAttribute("hidden", "");
  render([snapshot("2026-09-25", 100), snapshot("2026-09-26", 150)]);
  assert.equal(element("#asset-trend-chart").hidden, false);
  assert.equal(element("#asset-trend-chart").hasAttribute("hidden"), false, "SVG hidden attribute must be removed for CSS display");
  assert.match(element("#asset-trend-lines").innerHTML, /M[\d.]+,[\d.]+ L[\d.]+,[\d.]+/);
  assert.match(element("#asset-trend-area").innerHTML, /<path/);
  assert.equal(element("#asset-trend-points").innerHTML.match(/<circle/g)?.length, 2);
  render([snapshot("2026-09-26", 150)]);
  assert.equal(element("#asset-trend-chart").hidden, false, "one value renders as a point");
  assert.equal(element("#asset-trend-points").innerHTML.match(/<circle/g)?.length, 1);
  assert.equal(element("#asset-trend-lines").innerHTML, "", "one value has no line segment");
  render([snapshot("2026-09-25", null), snapshot("2026-09-26", null)]);
  assert.equal(element("#asset-trend-chart").hidden, true);
  assert.notEqual(element("#asset-trend-message").textContent, "");
  render([]);
  assert.equal(element("#asset-trend-chart").hidden, true);
  assert.match(element("#asset-trend-message").textContent, /スナップショット|価格更新/);
});

test("trend period filtering uses JST date strings and preserves sorted null snapshots", () => {
  const { context } = appContext();
  const series = [
    { date: "2026-09-27", valueJpy: 3, isComplete: true },
    { date: "2026-06-27", valueJpy: null, isComplete: false },
    { date: "2026-03-26", valueJpy: 1, isComplete: true },
    { date: "2025-09-27", valueJpy: 0, isComplete: true }
  ];
  assert.deepEqual(Array.from(context.filterSnapshotSeriesByRange(series, "1m"), point => point.date), ["2026-09-27"]);
  assert.deepEqual(Array.from(context.filterSnapshotSeriesByRange(series, "3m"), point => point.date), ["2026-06-27", "2026-09-27"]);
  assert.deepEqual(Array.from(context.filterSnapshotSeriesByRange(series, "6m"), point => point.date), ["2026-06-27", "2026-09-27"]);
  assert.deepEqual(Array.from(context.filterSnapshotSeriesByRange(series, "ytd"), point => point.date), ["2026-03-26", "2026-06-27", "2026-09-27"]);
  assert.deepEqual(Array.from(context.filterSnapshotSeriesByRange(series, "1y"), point => point.date), ["2025-09-27", "2026-03-26", "2026-06-27", "2026-09-27"]);
  assert.deepEqual(Array.from(context.filterSnapshotSeriesByRange(series, "all"), point => point.date), ["2025-09-27", "2026-03-26", "2026-06-27", "2026-09-27"]);
  assert.equal(context.filterSnapshotSeriesByRange(series, "3m")[0].isComplete, false);
  assert.equal(context.filterSnapshotSeriesByRange(series, "3m")[0].valueJpy, null);
});

test("previous-snapshot comparison calculation remains available after hiding it from the TOP card", () => {
  const { context } = appContext();
  assert.deepEqual(JSON.parse(JSON.stringify(context.calculateSnapshotChange([
    { valueJpy: 100, isComplete: true }, { valueJpy: null, isComplete: false }, { valueJpy: 150, isComplete: false }
  ]))), { valueJpy: 50, ratePercent: 50 });
  assert.deepEqual(JSON.parse(JSON.stringify(context.calculateSnapshotChange([{ valueJpy: 100 }, { valueJpy: null }]))), { valueJpy: null, ratePercent: null });
});

test("detail period change compares the first and last valid values", () => {
  const { context } = appContext();
  const calculate = values => JSON.parse(JSON.stringify(context.calculatePeriodChange(values.map(valueJpy => ({ valueJpy })))));
  assert.deepEqual(calculate([100, null, 150, 180]), { valueJpy: 80, ratePercent: 80 });
  assert.deepEqual(calculate([200, 150]), { valueJpy: -50, ratePercent: -25 });
  assert.deepEqual(calculate([100, 100]), { valueJpy: 0, ratePercent: 0 });
  assert.deepEqual(calculate([0, 150]), { valueJpy: 150, ratePercent: null });
  assert.deepEqual(calculate([100, null]), { valueJpy: null, ratePercent: null });
});

test("detail uses cached total and account snapshot series, including incomplete values", () => {
  const { context, element } = appContext();
  const snapshots = [
    { ...snapshot("2026-08-01", 80), accounts: [{ accountId: "a1", valueJpy: 5 }] },
    { ...snapshot("2026-09-20", 100), accounts: [{ accountId: "a1", valueJpy: 10 }] },
    { ...snapshot("2026-09-23", null), accounts: [{ accountId: "a1", valueJpy: null }] },
    { ...snapshot("2026-09-27", 160, false), accounts: [{ accountId: "a1", valueJpy: 30 }] }
  ];
  context.renderAssetTrendDetail({ snapshots });
  assert.equal(element("#trend-detail-current").textContent, yen(160));
  assert.equal(element("#trend-detail-previous-amount").textContent, `+${yen(60)}`);
  assert.equal(element("#trend-detail-previous-rate").textContent, "+60.00%");
  assert.equal(element("#trend-detail-period").textContent, "9/20 → 9/27");
  assert.equal(element("#trend-detail-change-amount").textContent, `+${yen(60)}`);
  assert.equal(element("#trend-detail-change-rate").textContent, "+60.00%");
  assert.match(element("#trend-detail-points").innerHTML, /data-complete="false"/);
  assert.match(element("#trend-detail-points").innerHTML, /data-trend-point/);
  assert.equal(element("#trend-detail-lines").innerHTML, "", "a null snapshot breaks the line");
  context.renderAssetTrendDetail({ snapshots: snapshots.filter(item => item.date !== "2026-09-23") });
  assert.match(element("#trend-detail-lines").innerHTML, /M[\d.]+,[\d.]+ L[\d.]+,[\d.]+/, "two adjacent values form a line");

  vm.runInContext('data.accounts = [{ id: "a1", name: "SBI証券" }]; selectedTrendDetailAccountId = "a1"', context);
  context.renderTrendDetailAccountOptions();
  assert.match(element("#trend-detail-account").innerHTML, /SBI証券/);
  context.renderAssetTrendDetail({ snapshots });
  assert.equal(element("#trend-detail-target-label").textContent, "SBI証券");
  assert.equal(element("#trend-detail-current").textContent, yen(30));
  assert.equal(element("#trend-detail-previous-amount").textContent, `+${yen(20)}`);
  assert.equal(element("#trend-detail-previous-rate").textContent, "+200.00%");
  assert.equal(element("#trend-detail-change-amount").textContent, `+${yen(20)}`);
  assert.equal(element("#trend-detail-change-rate").textContent, "+200.00%");
});

test("detail handles zero, one, and missing account snapshot values", () => {
  const { context, element } = appContext();
  context.renderAssetTrendDetail({ snapshots: [] });
  assert.equal(element("#trend-detail-current").textContent, "—");
  assert.equal(element("#trend-detail-chart").hidden, true);
  context.renderAssetTrendDetail({ snapshots: [snapshot("2026-09-27", 125)] });
  assert.equal(element("#trend-detail-current").textContent, yen(125));
  assert.equal(element("#trend-detail-previous-amount").textContent, "—");
  assert.equal(element("#trend-detail-period").textContent, "9/27");
  assert.equal(element("#trend-detail-change-amount").textContent, "—");
  assert.equal(element("#trend-detail-chart").hidden, false);
  vm.runInContext('data.accounts = [{ id: "a1", name: "SBI証券" }]; selectedTrendDetailAccountId = "a1"', context);
  context.renderAssetTrendDetail({ snapshots: [snapshot("2026-09-27", 125)] });
  assert.equal(element("#trend-detail-current").textContent, "—");
  assert.equal(element("#trend-detail-period").textContent, "—");
  assert.equal(element("#trend-detail-chart").hidden, true);
});

test("total-value card sparkline reuses real snapshot values and requires a connected pair", () => {
  const { context, element } = appContext();
  context.renderAssetTrend({ to: "2026-09-27", snapshots: [
    snapshot("2026-09-26", 100), snapshot("2026-09-27", 125)
  ] });
  assert.equal(element("#total-value-sparkline").hidden, false);
  assert.match(element("#total-value-sparkline-path").innerHTML, /M0\.0,/);
  assert.match(element("#total-value-sparkline-path").innerHTML, /L320\.0,/);

  context.renderAssetTrend({ to: "2026-09-27", snapshots: [snapshot("2026-09-27", 125)] });
  assert.equal(element("#total-value-sparkline").hidden, true, "one snapshot is not a trend line");
  assert.equal(element("#asset-trend-chart").hidden, false, "the larger trend can still show a single snapshot point");
});

test("JPY amount formatting uses Japanese suffix and keeps signed values", () => {
  const { context } = appContext();
  assert.equal(vm.runInContext('formatJpyAmount(37959359)', context), "37,959,359円");
  assert.equal(vm.runInContext('signed(3520)', context), "+3,520円");
  assert.equal(vm.runInContext('signed(-81927)', context), "-81,927円");
  assert.equal(vm.runInContext('signed(0)', context), "0円");
  assert.equal(vm.runInContext('formatJpyAmount(null)', context), "—");
});

test("holding current prices display Japanese currency labels without changing stored codes", () => {
  const { context } = appContext();
  assert.equal(vm.runInContext('formatHoldingPrice({ price: 1063, currency: "JPY" })', context), "1,063円");
  assert.equal(vm.runInContext('formatHoldingPrice({ price: 1082.28, currency: "USD" })', context), "1,082.28ドル");
});

test("dashboard summary cards wrap only their yen unit for smaller styling", () => {
  const { context } = appContext();
  assert.equal(vm.runInContext('formatMetricJpyAmount(37959359)', context), '<span class="metric-amount">37,959,359</span><span class="metric-unit">円</span>');
  assert.equal(vm.runInContext('formatMetricJpyAmount(3520, true)', context), '+<span class="metric-amount">3,520</span><span class="metric-unit">円</span>');
  assert.equal(vm.runInContext('formatMetricJpyAmount(-81927, true)', context), '-<span class="metric-amount">81,927</span><span class="metric-unit">円</span>');
  assert.equal(vm.runInContext('formatMetricJpyAmount(null, true)', context), "—");
});

test("TOP keeps the main total and detail link, without a second total in the trend", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /<strong id="total-value">/);
  assert.match(html, /<span id="total-cost">/);
  assert.equal((html.match(/class="metric-icon"/g) || []).length, 3);
  assert.match(html, /id="total-value-sparkline"/);
  assert.match(html, /data-trend-details>詳細を見る &gt;<\/button>/);
  assert.match(html, /id="trend-view" class="view"/);
  assert.match(html, /id="trend-detail-account"/);
  assert.match(html, /data-go="dashboard">← TOPへ戻る/);
  for (const range of ["1m", "3m", "6m", "ytd", "1y", "all"]) assert.match(html, new RegExp(`data-trend-range="${range}"`));
  assert.match(html, /data-trend-range="ytd"[^>]*>年初来<\/button>/);
  assert.match(html, /id="asset-trend-area"/);
  assert.match(html, /id="asset-trend-x-labels"/);
  assert.match(html, /id="asset-trend-y-labels"/);
  assert.doesNotMatch(html, /asset-trend-delta/);
  assert.doesNotMatch(html, /asset-trend-latest|最新の総資産額/);
});
