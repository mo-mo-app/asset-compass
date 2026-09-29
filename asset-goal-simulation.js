(function attachAssetGoalSimulation(root, createApi) {
  const api = createApi();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else if (root) {
    root.AssetGoalSimulation = api;
  }
})(typeof globalThis === "object" ? globalThis : this, function createAssetGoalSimulationApi() {
  const MAX_MONTHS = 1200;

  function parseStartDate(startDate) {
    if (startDate === undefined || startDate === null) {
      const now = new Date();
      return { year: now.getFullYear(), month: now.getMonth() + 1 };
    }
    if (startDate instanceof Date) {
      if (!Number.isFinite(startDate.getTime())) throw new TypeError("startDate must be a valid Date or YYYY-MM string.");
      return { year: startDate.getFullYear(), month: startDate.getMonth() + 1 };
    }
    if (typeof startDate !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(startDate)) {
      throw new TypeError("startDate must be a valid Date or YYYY-MM string.");
    }
    const [year, month] = startDate.split("-").map(Number);
    if (year < 1) throw new RangeError("startDate year must be greater than 0.");
    return { year, month };
  }

  function formatYearMonth(year, month) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  }

  function addMonths(year, month, amount) {
    const absoluteMonth = year * 12 + month - 1 + amount;
    return {
      year: Math.floor(absoluteMonth / 12),
      month: absoluteMonth % 12 + 1
    };
  }

  function createPoint(month, date, assets, cumulativeContribution, initialAssets) {
    return {
      month,
      date,
      assets,
      cumulativeContribution,
      investmentGain: assets - initialAssets - cumulativeContribution
    };
  }

  function calculateAssetGoalSimulation({
    currentAssets,
    targetAssets,
    monthlyContribution,
    annualReturnRate,
    startDate
  } = {}) {
    const numericInputs = { currentAssets, targetAssets, monthlyContribution, annualReturnRate };
    for (const [name, value] of Object.entries(numericInputs)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${name} must be a finite number.`);
      }
    }
    if (targetAssets <= 0) throw new RangeError("targetAssets must be greater than 0.");
    if (currentAssets < 0) throw new RangeError("currentAssets must be 0 or greater.");
    if (monthlyContribution < 0) throw new RangeError("monthlyContribution must be 0 or greater.");
    if (annualReturnRate <= -100) throw new RangeError("annualReturnRate must be greater than -100.");

    const start = parseStartDate(startDate);
    const initialAssets = currentAssets;
    const monthlyRate = Math.pow(1 + annualReturnRate / 100, 1 / 12) - 1;
    if (!Number.isFinite(monthlyRate)) throw new RangeError("annualReturnRate is outside the supported numeric range.");

    const achievementRate = currentAssets / targetAssets * 100;
    const remainingAmount = Math.max(targetAssets - currentAssets, 0);
    const simulationData = [createPoint(0, formatYearMonth(start.year, start.month), currentAssets, 0, initialAssets)];

    if (currentAssets >= targetAssets) {
      return {
        achievementRate,
        remainingAmount,
        monthsToGoal: 0,
        estimatedGoalDate: formatYearMonth(start.year, start.month),
        reachedGoal: true,
        finalAssets: currentAssets,
        simulationData
      };
    }

    let assets = currentAssets;
    for (let month = 1; month <= MAX_MONTHS; month += 1) {
      assets = assets * (1 + monthlyRate) + monthlyContribution;
      const cumulativeContribution = monthlyContribution * month;
      const date = addMonths(start.year, start.month, month);
      simulationData.push(createPoint(month, formatYearMonth(date.year, date.month), assets, cumulativeContribution, initialAssets));

      if (assets >= targetAssets) {
        return {
          achievementRate,
          remainingAmount,
          monthsToGoal: month,
          estimatedGoalDate: formatYearMonth(date.year, date.month),
          reachedGoal: true,
          finalAssets: assets,
          simulationData
        };
      }
    }

    return {
      achievementRate,
      remainingAmount,
      monthsToGoal: null,
      estimatedGoalDate: null,
      reachedGoal: false,
      finalAssets: assets,
      simulationData
    };
  }

  return { MAX_MONTHS, calculateAssetGoalSimulation };
});
