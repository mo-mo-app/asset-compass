const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MAX_MONTHS, calculateAssetGoalSimulation } = require("../asset-goal-simulation");

const closeTo = (actual, expected, tolerance = 1e-8) => {
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
};
const baseInput = {
  currentAssets: 37959359,
  targetAssets: 100000000,
  monthlyContribution: 173000,
  annualReturnRate: 7,
  startDate: "2026-09"
};

test("standard compound monthly simulation reaches the goal in 115 months", () => {
  const result = calculateAssetGoalSimulation(baseInput);

  closeTo(result.achievementRate, 37.959359, 1e-10);
  assert.equal(result.remainingAmount, 62040641);
  assert.equal(result.monthsToGoal, 115);
  assert.equal(result.estimatedGoalDate, "2036-04");
  assert.equal(result.reachedGoal, true);
  assert.ok(result.finalAssets >= 100000000);

  assert.deepEqual(result.simulationData[0], {
    month: 0,
    date: "2026-09",
    assets: 37959359,
    cumulativeContribution: 0,
    investmentGain: 0
  });
  const firstMonth = result.simulationData[1];
  assert.equal(firstMonth.month, 1);
  assert.equal(firstMonth.date, "2026-10");
  assert.equal(firstMonth.cumulativeContribution, 173000);
  closeTo(firstMonth.investmentGain, firstMonth.assets - 37959359 - 173000);

  const last = result.simulationData.at(-1);
  assert.equal(last.month, 115);
  assert.equal(last.date, "2036-04");
  assert.ok(last.assets >= 100000000);
});

test("zero annual return with monthly contributions reaches the goal in 359 months", () => {
  const result = calculateAssetGoalSimulation({ ...baseInput, annualReturnRate: 0 });

  assert.equal(result.monthsToGoal, 359);
  assert.equal(result.estimatedGoalDate, "2056-08");
  assert.equal(result.reachedGoal, true);
  assert.ok(result.simulationData.every(point => point.investmentGain === 0));
});

test("monthly contributions of zero with 7% annual return reaches the goal in 172 months", () => {
  const result = calculateAssetGoalSimulation({ ...baseInput, monthlyContribution: 0 });

  assert.equal(result.monthsToGoal, 172);
  assert.equal(result.estimatedGoalDate, "2041-01");
  assert.equal(result.reachedGoal, true);
  assert.ok(result.simulationData.every(point => point.cumulativeContribution === 0));
});

test("already reached target returns the start point and zero remaining amount", () => {
  const result = calculateAssetGoalSimulation({ ...baseInput, currentAssets: 120000000 });

  assert.equal(result.achievementRate, 120);
  assert.equal(result.remainingAmount, 0);
  assert.equal(result.monthsToGoal, 0);
  assert.equal(result.estimatedGoalDate, "2026-09");
  assert.equal(result.reachedGoal, true);
  assert.equal(result.finalAssets, 120000000);
  assert.equal(result.simulationData.length, 1);
});

test("negative annual return with contributions stays below the goal through the 1200-month limit", () => {
  const result = calculateAssetGoalSimulation({ ...baseInput, annualReturnRate: -3 });

  assert.equal(result.monthsToGoal, null);
  assert.equal(result.estimatedGoalDate, null);
  assert.equal(result.reachedGoal, false);
  assert.equal(result.simulationData.length, MAX_MONTHS + 1);
});

test("zero return and zero contributions leave assets unchanged and do not reach the goal", () => {
  const result = calculateAssetGoalSimulation({ ...baseInput, monthlyContribution: 0, annualReturnRate: 0 });

  assert.equal(result.monthsToGoal, null);
  assert.equal(result.estimatedGoalDate, null);
  assert.equal(result.reachedGoal, false);
  assert.equal(result.finalAssets, 37959359);
  assert.equal(result.simulationData.length, MAX_MONTHS + 1);
});

test("negative return and zero contributions do not reach the goal", () => {
  const result = calculateAssetGoalSimulation({ ...baseInput, monthlyContribution: 0, annualReturnRate: -3 });

  assert.equal(result.monthsToGoal, null);
  assert.equal(result.estimatedGoalDate, null);
  assert.equal(result.reachedGoal, false);
  assert.equal(result.simulationData.length, MAX_MONTHS + 1);
});

test("a Date startDate is accepted and reduced to its year and month", () => {
  const result = calculateAssetGoalSimulation({ ...baseInput, currentAssets: 100000000, startDate: new Date(2026, 8, 15) });

  assert.equal(result.estimatedGoalDate, "2026-09");
  assert.equal(result.simulationData[0].date, "2026-09");
});

test("invalid target, current assets, contribution, and annual return are rejected", () => {
  assert.throws(() => calculateAssetGoalSimulation({ ...baseInput, targetAssets: 0 }));
  assert.throws(() => calculateAssetGoalSimulation({ ...baseInput, currentAssets: -100000 }));
  assert.throws(() => calculateAssetGoalSimulation({ ...baseInput, monthlyContribution: -10000 }));
  assert.throws(() => calculateAssetGoalSimulation({ ...baseInput, annualReturnRate: -100 }));
});

test("NaN and Infinity numeric inputs are rejected", () => {
  assert.throws(() => calculateAssetGoalSimulation({ ...baseInput, currentAssets: NaN }));
  assert.throws(() => calculateAssetGoalSimulation({ ...baseInput, targetAssets: Infinity }));
  assert.throws(() => calculateAssetGoalSimulation({ ...baseInput, monthlyContribution: NaN }));
  assert.throws(() => calculateAssetGoalSimulation({ ...baseInput, annualReturnRate: Infinity }));
});
