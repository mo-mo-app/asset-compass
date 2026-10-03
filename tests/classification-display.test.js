const assert = require("node:assert/strict");
const { test } = require("node:test");
const display = require("../classification-display");
const { prepare } = require("./helpers/holding-ui");

test("stock labels use Japanese master values, user priority, and fixed axis order", () => {
  assert.deepEqual(display.getDisplayClassifications({ type: "米国株", user_sector_code: "ENERGY", auto_sector_code: "FINANCIALS", auto_sensitivity_code: "CYCLICAL" }), [
    { kind: "sector", axis: "セクター", color: "sector", code: "ENERGY", value: "エネルギー" },
    { kind: "sensitivity", axis: "景気感応度", color: "sensitivity", code: "CYCLICAL", value: "景気敏感" }
  ]);
});

test("fund and ETF labels show fund category then sensitivity without stock sector", () => {
  for (const holding of [
    { type: "投資信託", auto_fund_category_code: "BROAD_INDEX", user_sensitivity_code: "DEFENSIVE", auto_sector_code: "FINANCIALS" },
    { type: "米国株", auto_fund_category_code: "BROAD_INDEX", auto_sensitivity_code: "DEFENSIVE", auto_sector_code: "FINANCIALS" }
  ]) {
    assert.deepEqual(display.getDisplayClassifications(holding).map(item => item.value), ["広範囲株式指数", "ディフェンシブ"]);
    assert.deepEqual(display.getDisplayClassifications(holding).map(item => item.color), ["fund-category", "sensitivity"]);
  }
});

test("unconfigured and unknown classifications are omitted without exposing industry", () => {
  assert.deepEqual(display.getDisplayClassifications({ type: "日本株", auto_industry_code: "SEMICONDUCTORS", auto_sector_code: "UNKNOWN" }), []);
  assert.deepEqual(display.getDisplayClassifications({ type: "日本株", auto_sector_code: "MATERIALS" }).map(item => item.value), ["素材"]);
});

test("holding rows render compact non-industry pills under the ticker using escaped master labels", () => {
  const ui = prepare({ type: "米国株", currency: "USD", symbol: "NVDA" });
  const row = ui.context.holdingRow({
    id: "h", accountId: "account-1", type: "米国株", currency: "USD", name: "NVIDIA", symbol: "NVDA", quantity: 2, cost: 100,
    auto_sector_code: "INFORMATION_TECHNOLOGY", user_sensitivity_code: "CYCLICAL", auto_sensitivity_code: "DEFENSIVE", auto_industry_code: "SEMICONDUCTORS"
  });
  assert.match(row, /holding-meta[\s\S]*holding-classification-pills[\s\S]*情報技術[\s\S]*景気敏感/);
  assert.match(row, /classification-pill--sector/);
  assert.match(row, /classification-pill--sensitivity/);
  assert.doesNotMatch(row, /SEMICONDUCTORS|INFORMATION_TECHNOLOGY|DEFENSIVE/);

  const empty = ui.context.holdingRow({ id: "e", accountId: "account-1", type: "日本株", name: "分類なし", symbol: "0000", quantity: 1, cost: 1 });
  assert.doesNotMatch(empty, /holding-classification-pills|classification-pill/);
});
