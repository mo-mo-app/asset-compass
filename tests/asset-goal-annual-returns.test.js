const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const AssetGoalSimulation = require("../asset-goal-simulation");

const root = path.resolve(__dirname, "..");

function appContext() {
  const context = vm.createContext({
    Intl,
    console,
    AssetGoalSimulation,
    window: { innerWidth: 1280 },
    localStorage: { getItem: () => JSON.stringify({ accounts: [], holdings: [] }) },
    document: { querySelector: () => ({}) }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "symbols.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "holding-number-rules.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener("click"')), context);
  return context;
}

test("annual returns include a simulation that ends within its first year", () => {
  const result = AssetGoalSimulation.calculateAssetGoalSimulation({
    currentAssets: 1000,
    targetAssets: 1500,
    monthlyContribution: 100,
    annualReturnRate: 0,
    startDate: "2026-09"
  });
  const rows = appContext().buildGoalAnnualReturnData(result.simulationData);

  assert.equal(result.estimatedGoalDate, "2027-02");
  assert.deepEqual(Array.from(rows, row => ({
    year: row.year,
    startAssets: row.startAssets,
    endAssets: row.endAssets,
    annualContribution: row.annualContribution,
    annualInvestmentGain: row.annualInvestmentGain,
    annualReturnRate: row.annualReturnRate
  })), [
    { year: 2026, startAssets: 1000, endAssets: 1300, annualContribution: 300, annualInvestmentGain: 0, annualReturnRate: 0 },
    { year: 2027, startAssets: 1300, endAssets: 1500, annualContribution: 200, annualInvestmentGain: 0, annualReturnRate: 0 }
  ]);
});

test("annual returns count month-end contributions in each partial year across multiple years", () => {
  const result = AssetGoalSimulation.calculateAssetGoalSimulation({
    currentAssets: 1000,
    targetAssets: 2800,
    monthlyContribution: 100,
    annualReturnRate: 0,
    startDate: "2026-09"
  });
  const rows = appContext().buildGoalAnnualReturnData(result.simulationData);

  assert.equal(result.estimatedGoalDate, "2028-03");
  assert.deepEqual(Array.from(rows, row => ({
    year: row.year,
    startAssets: row.startAssets,
    endAssets: row.endAssets,
    annualContribution: row.annualContribution,
    annualInvestmentGain: row.annualInvestmentGain,
    annualReturnRate: row.annualReturnRate
  })), [
    { year: 2026, startAssets: 1000, endAssets: 1300, annualContribution: 300, annualInvestmentGain: 0, annualReturnRate: 0 },
    { year: 2027, startAssets: 1300, endAssets: 2500, annualContribution: 1200, annualInvestmentGain: 0, annualReturnRate: 0 },
    { year: 2028, startAssets: 2500, endAssets: 2800, annualContribution: 300, annualInvestmentGain: 0, annualReturnRate: 0 }
  ]);
});

test("annual investment gain and return rate exclude that year's contributions", () => {
  const simulationData = [
    { month: 0, date: "2026-09", assets: 1000, cumulativeContribution: 0, investmentGain: 0 },
    { month: 1, date: "2026-10", assets: 1110, cumulativeContribution: 100, investmentGain: 10 },
    { month: 2, date: "2026-11", assets: 1220, cumulativeContribution: 200, investmentGain: 20 },
    { month: 3, date: "2026-12", assets: 1330, cumulativeContribution: 300, investmentGain: 30 },
    { month: 4, date: "2027-01", assets: 1440, cumulativeContribution: 400, investmentGain: 40 },
    { month: 5, date: "2027-02", assets: 1550, cumulativeContribution: 500, investmentGain: 50 }
  ];
  const rows = appContext().buildGoalAnnualReturnData(simulationData);

  assert.equal(rows[0].annualInvestmentGain, 30);
  assert.equal(rows[0].annualReturnRate, 3);
  assert.equal(rows[1].startAssets, 1330);
  assert.equal(rows[1].annualContribution, 200);
  assert.equal(rows[1].annualInvestmentGain, 20);
  assert.ok(Math.abs(rows[1].annualReturnRate - (20 / 1330 * 100)) < 1e-12);
});
