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

test("instrument kind resolution prioritizes explicit kind, valid classifications, then the legacy type", () => {
  assert.equal(display.resolveInstrumentKind({ type: "米国株", instrument_kind: "ETF", auto_sector_code: "ENERGY" }), "ETF");
  assert.equal(display.resolveInstrumentKind({ type: "日本株", instrument_kind: "STOCK", auto_fund_category_code: "BROAD_INDEX" }), "STOCK");
  assert.equal(display.resolveInstrumentKind({ type: "米国株", instrument_kind: null, user_fund_category_code: "BROAD_INDEX", auto_sector_code: "ENERGY" }), "ETF");
  assert.equal(display.resolveInstrumentKind({ type: "日本株", instrument_kind: null, auto_sector_code: "ENERGY" }), "STOCK");
  assert.equal(display.resolveInstrumentKind({ type: "米国株", instrument_kind: null, auto_fund_category_code: "UNKNOWN", auto_sector_code: "UNKNOWN" }), "STOCK");
  assert.equal(display.resolveInstrumentKind({ type: "投資信託", auto_fund_category_code: "BROAD_INDEX" }), null);
  assert.deepEqual(display.getDisplayClassifications({ type: "日本株", instrument_kind: "ETF", user_fund_category_code: "HIGH_DIVIDEND", user_sensitivity_code: "DEFENSIVE" }).map(item => item.value), ["高配当", "ディフェンシブ"]);
  assert.deepEqual(display.getDisplayClassifications({ type: "米国株", instrument_kind: "ETF", auto_sector_code: "ENERGY", auto_sensitivity_code: "CYCLICAL" }).map(item => item.value), ["景気敏感"]);
  assert.deepEqual(display.getDisplayClassifications({ type: "米国株", instrument_kind: "STOCK", auto_fund_category_code: "BROAD_INDEX", auto_sector_code: "ENERGY" }).map(item => item.value), ["エネルギー"]);
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

test("holding metadata omits the account and groups stock quote time or fund base date with ticker metadata", () => {
  const ui = prepare({ type: "米国株", currency: "USD", symbol: "SOXL" });
  const stock = ui.context.holdingRow({
    id: "stock", accountId: "account-1", type: "米国株", currency: "USD", name: "Direxion", symbol: "SOXL", quantity: 1, cost: 10,
    priceTimestamp: Date.UTC(2026, 9, 2, 20, 0)
  });
  assert.match(stock, /holding-meta-line[\s\S]*SOXL<span class="holding-meta-type"> · 米国株<\/span>[\s\S]*holding-updated">価格日時 10\/3 05:00/);
  assert.doesNotMatch(stock, /証券口座1/);

  const fund = ui.context.holdingRow({
    id: "fund", accountId: "account-1", type: "投資信託", currency: "JPY", name: "インデックスファンド", symbol: "fund", quantity: 1, cost: 10000,
    priceDate: "10/2"
  });
  assert.match(fund, /holding-meta-line[\s\S]*holding-updated">基準日 10\/2/);
  assert.doesNotMatch(fund, /証券口座1/);
});
