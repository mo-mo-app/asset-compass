const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const AssetGoalSimulation = require("../asset-goal-simulation");

const root = path.resolve(__dirname, "..");

function goalChartContext(innerWidth = 1280) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: "", textContent: "", innerHTML: "", hidden: false, disabled: false, dataset: {}, style: { setProperty() {} }, clientWidth: 360, clientHeight: innerWidth <= 600 ? 270 : 330,
      attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, value); },
      replaceChildren() { this.innerHTML = ""; }
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    Intl, console, AssetGoalSimulation, window: { innerWidth },
    localStorage: { getItem: () => JSON.stringify({ accounts: [], holdings: [] }) },
    document: { querySelector: element }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "symbols.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "holding-number-rules.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener("click"')), context);
  return { context, element };
}

const baseInput = {
  currentAssets: 37959359,
  targetAssets: 100000000,
  monthlyContribution: 173000,
  annualReturnRate: 7,
  startDate: "2026-09"
};

test("missing saved goal settings preserve form defaults and only initialize the start month", async () => {
  const { context, element } = goalChartContext();
  element("#goal-current-assets").value = "123,456";
  element("#goal-target-assets").value = "100,000,000";
  element("#goal-monthly-contribution").value = "0";
  element("#goal-annual-return").value = "7";
  context.fetch = async () => ({ ok: true, json: async () => ({ settings: null }) });

  assert.equal(await context.loadAssetGoalSettings(), null);
  assert.equal(element("#goal-current-assets").value, "123,456");
  assert.equal(element("#goal-target-assets").value, "100,000,000");
  assert.equal(element("#goal-monthly-contribution").value, "0");
  assert.equal(element("#goal-annual-return").value, "7");
  assert.match(element("#goal-start-month").value, /^\d{4}-(0[1-9]|1[0-2])$/);
});

test("saved goal settings restore and save inputs separately from current assets", async () => {
  const { context, element } = goalChartContext();
  const settings = {
    target_amount: 85000000,
    annual_return_rate: 5.5,
    monthly_contribution: 125000,
    start_month: "2026-10",
    show_on_dashboard: false
  };
  let persisted = settings;
  let savedBody = null;
  let topView = null;
  context.fetch = async (_url, options) => {
    if (!options?.method) return { ok: true, json: async () => ({ settings: persisted }) };
    savedBody = JSON.parse(options.body).settings;
    persisted = savedBody;
    return { ok: true, json: async () => ({ settings: persisted }) };
  };
  context.showAppView = view => { topView = view; };
  element("#goal-current-assets").value = "4,500,000";

  assert.deepEqual(JSON.parse(JSON.stringify(await context.loadAssetGoalSettings())), settings);
  assert.equal(element("#goal-target-assets").value, "85,000,000");
  assert.equal(element("#goal-monthly-contribution").value, "125,000");
  assert.equal(element("#goal-annual-return").value, "5.5");
  assert.equal(element("#goal-start-month").value, "2026-10");
  assert.equal(element("#goal-current-assets").value, "4,500,000", "current assets are not part of the saved settings");

  await context.saveAssetGoalSettings(false);
  assert.deepEqual(savedBody, settings);
  assert.equal(topView, null);
  await context.saveAssetGoalSettings(true);
  assert.equal(savedBody.show_on_dashboard, true);
  assert.equal(topView, null, "saving for TOP keeps the goal details open");
  assert.equal(element("#goal-settings-status").textContent, "目標設定を保存しました。");
});

test("standard goal simulation draws asset and target lines with the exact goal month", () => {
  const { context, element } = goalChartContext();
  const result = AssetGoalSimulation.calculateAssetGoalSimulation(baseInput);

  context.renderGoalChart(result, baseInput.targetAssets);
  assert.equal(result.simulationData.length, 116);
  assert.equal(element("#goal-chart-panel").hidden, false);
  assert.match(element("#goal-chart").innerHTML, /class="goal-chart-line"/);
  assert.match(element("#goal-chart").innerHTML, /class="goal-chart-target"/);
  assert.match(element("#goal-chart").innerHTML, /class="goal-chart-goal-marker"/);
  assert.match(element("#goal-chart").innerHTML, /達成 2036年4月/);
  assert.doesNotMatch(element("#goal-chart").innerHTML, />目標 1億円<\/text>/, "the target amount is not shown as a visible chart label");
  assert.match(element("#goal-chart").attributes.get("aria-label"), /目標 100,000,000円/);
  const yAxisLabels = Array.from(element("#goal-chart").innerHTML.matchAll(/<text class="goal-chart-y-label"[^>]*>(.*?)<\/text>/g), match => match[1]);
  const minAssets = Math.min(baseInput.targetAssets, ...result.simulationData.map(point => point.assets));
  const maxAssets = Math.max(baseInput.targetAssets, ...result.simulationData.map(point => point.assets));
  const tickStep = context.getGoalChartTickStep(minAssets, maxAssets);
  const expectedAxisMaximum = (Math.floor(maxAssets / tickStep) + 1) * tickStep;
  assert.equal(yAxisLabels.at(-1), context.formatGoalChartAmount(expectedAxisMaximum));
  assert.ok(yAxisLabels.length <= 7, "Y-axis labels stay within the current maximum tick count");
  assert.notEqual(yAxisLabels.at(-1), context.formatGoalChartAmount(baseInput.targetAssets), "top tick leaves visible headroom above the target line");
  assert.match(element("#goal-chart").innerHTML, /data-goal-chart-index="115"/);
  assert.match(element("#goal-chart").attributes.get("aria-label"), /2036年4月/);
});

test("already reached target draws a single point and the starting goal marker", () => {
  const { context, element } = goalChartContext();
  const result = AssetGoalSimulation.calculateAssetGoalSimulation({ ...baseInput, currentAssets: 120000000 });

  context.renderGoalChart(result, baseInput.targetAssets);
  assert.equal(result.simulationData.length, 1);
  assert.equal(element("#goal-chart-panel").hidden, false);
  assert.match(element("#goal-chart").innerHTML, /class="goal-chart-single-point"/);
  assert.match(element("#goal-chart").innerHTML, /class="goal-chart-goal-marker"/);
});

test("recalculation replaces the old chart and uses the new target amount", () => {
  const { context, element } = goalChartContext();
  const firstResult = AssetGoalSimulation.calculateAssetGoalSimulation(baseInput);
  context.renderGoalChart(firstResult, baseInput.targetAssets);
  const previousLine = element("#goal-chart").innerHTML.match(/<path class="goal-chart-line" d="([^"]+)"/)[1];

  const nextInput = { ...baseInput, targetAssets: 75000000, monthlyContribution: 250000 };
  const nextResult = AssetGoalSimulation.calculateAssetGoalSimulation(nextInput);
  context.renderGoalChart(nextResult, nextInput.targetAssets);
  const nextSvg = element("#goal-chart").innerHTML;
  const nextLine = nextSvg.match(/<path class="goal-chart-line" d="([^"]+)"/)[1];
  assert.doesNotMatch(nextSvg, />目標 (?:7,500万円|1億円)<\/text>/, "target amounts are not shown as visible chart labels");
  assert.match(element("#goal-chart").attributes.get("aria-label"), /目標 75,000,000円/);
  assert.doesNotMatch(element("#goal-chart").attributes.get("aria-label"), /目標 100,000,000円/);
  assert.notEqual(nextLine, previousLine);
});

test("unreachable 1201-point series stays drawable without a goal marker or null coordinates", () => {
  const { context, element } = goalChartContext(390);
  const result = AssetGoalSimulation.calculateAssetGoalSimulation({ ...baseInput, annualReturnRate: -3 });

  context.renderGoalChart(result, baseInput.targetAssets);
  const svg = element("#goal-chart").innerHTML;
  assert.equal(result.simulationData.length, 1201);
  assert.equal(element("#goal-chart-panel").hidden, false);
  assert.match(svg, /class="goal-chart-line"/);
  assert.match(svg, /class="goal-chart-target"/);
  assert.doesNotMatch(svg, /goal-chart-goal-marker|NaN|null/);
  assert.ok((svg.match(/class="goal-chart-hit"/g) || []).length < 30, "interactive markers are downsampled for small screens");
});

test("clearing invalidated simulation results also removes the previous chart", () => {
  const { context, element } = goalChartContext();
  const result = AssetGoalSimulation.calculateAssetGoalSimulation(baseInput);

  context.renderGoalChart(result, baseInput.targetAssets);
  context.clearGoalSimulationResults("入力エラー");
  assert.equal(element("#goal-chart-panel").hidden, true);
  assert.equal(element("#goal-chart").innerHTML, "");
});
