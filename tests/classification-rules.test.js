const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeDrillrSector, normalizeIndustryCode, normalizeJapaneseIndustry, classifySensitivity, parseYahooJapaneseIndustry } = require("../classification-rules");
const { getEntry } = require("../classification-masters");
const fs = require("node:fs");
const path = require("node:path");

const us = {
  Energy: "ENERGY", "Basic Materials": "MATERIALS", Industrials: "INDUSTRIALS",
  "Consumer Cyclical": "CONSUMER_DISCRETIONARY", "Consumer Defensive": "CONSUMER_STAPLES", Healthcare: "HEALTH_CARE",
  "Financial Services": "FINANCIALS", Technology: "INFORMATION_TECHNOLOGY", "Communication Services": "COMMUNICATION_SERVICES",
  Utilities: "UTILITIES", "Real Estate": "REAL_ESTATE"
};
test("all drillr sectors normalize to existing internal sector codes without guessing", () => {
  for (const [value, code] of Object.entries(us)) {
    assert.equal(normalizeDrillrSector(value), code);
    assert.ok(getEntry("sector", code));
  }
  assert.equal(normalizeDrillrSector("  financial   SERVICES  "), "FINANCIALS");
  for (const value of ["Unknown", "Semiconductors", "Other", "", null, undefined, {}, 1]) assert.equal(normalizeDrillrSector(value), null);
});
test("industry normalization produces bounded ASCII codes, not display names", () => {
  assert.equal(normalizeIndustryCode("Semiconductors"), "SEMICONDUCTORS");
  assert.equal(normalizeIndustryCode("Software - Infrastructure"), "SOFTWARE_INFRASTRUCTURE");
  assert.equal(normalizeIndustryCode(" / Software --- Infrastructure / "), "SOFTWARE_INFRASTRUCTURE");
  assert.equal(normalizeIndustryCode("Oil & Gas / E&P"), "OIL_GAS_E_P");
  assert.equal(normalizeIndustryCode("Métals"), "METALS");
  assert.equal(normalizeIndustryCode("x".repeat(128)), "X".repeat(128));
  for (const value of ["x".repeat(129), "---", "", "不明", "N/A", "Unknown", null, undefined, {}, 123]) assert.equal(normalizeIndustryCode(value), null);
});

const jp = [
  ["水産・農林業", "CONSUMER_STAPLES"], ["鉱業", "MATERIALS"], ["建設業", "INDUSTRIALS"], ["食料品", "CONSUMER_STAPLES"],
  ["繊維製品", "CONSUMER_DISCRETIONARY"], ["パルプ・紙", "MATERIALS"], ["化学", "MATERIALS"], ["医薬品", "HEALTH_CARE"],
  ["石油・石炭製品", "ENERGY"], ["ゴム製品", "CONSUMER_DISCRETIONARY"], ["ガラス・土石製品", "MATERIALS"], ["鉄鋼", "MATERIALS"],
  ["非鉄金属", "MATERIALS"], ["金属製品", "MATERIALS"], ["機械", "INDUSTRIALS"], ["電気機器", "INFORMATION_TECHNOLOGY"],
  ["輸送用機器", "CONSUMER_DISCRETIONARY"], ["精密機器", "INFORMATION_TECHNOLOGY"], ["その他製品", "CONSUMER_DISCRETIONARY"],
  ["電気・ガス業", "UTILITIES"], ["陸運業", "INDUSTRIALS"], ["海運業", "INDUSTRIALS"], ["空運業", "INDUSTRIALS"],
  ["倉庫・運輸関連業", "INDUSTRIALS"], ["情報・通信業", "COMMUNICATION_SERVICES"], ["卸売業", "INDUSTRIALS"],
  ["小売業", "CONSUMER_DISCRETIONARY"], ["銀行業", "FINANCIALS"], ["証券・商品先物取引業", "FINANCIALS"],
  ["保険業", "FINANCIALS"], ["その他金融業", "FINANCIALS"], ["不動産業", "REAL_ESTATE"], ["サービス業", "INDUSTRIALS"]
];
test("all 33 Japanese industries map to the requested sector fallback and distinct valid industry codes", () => {
  const codes = [];
  assert.equal(jp.length, 33);
  for (const [label, sectorCode] of jp) {
    const actual = normalizeJapaneseIndustry(label);
    assert.equal(actual.sectorCode, sectorCode, label);
    assert.ok(getEntry("sector", actual.sectorCode));
    assert.match(actual.industryCode, /^[A-Za-z0-9_.:-]{1,128}$/);
    codes.push(actual.industryCode);
  }
  assert.equal(new Set(codes).size, 33);
  assert.deepEqual(normalizeJapaneseIndustry("保険業"), { industryCode: "INSURANCE", sectorCode: "FINANCIALS" });
  assert.deepEqual(normalizeJapaneseIndustry("情報・通信"), { industryCode: "INFORMATION_COMMUNICATIONS", sectorCode: "COMMUNICATION_SERVICES" });
  assert.equal(normalizeJapaneseIndustry("未知業種"), null);
  assert.equal(normalizeJapaneseIndustry("保険業・情報通信"), null);
});
test("Yahoo profile extraction uses primary industry fields, tolerates entities and rejects ambiguous pages", () => {
  for (const [symbol, code] of [["8766", "INSURANCE"], ["9432", "INFORMATION_COMMUNICATIONS"]]) {
    const html = fs.readFileSync(path.join(__dirname, "fixtures/classification", `yahoo-${symbol}.html`), "utf8");
    assert.equal(parseYahooJapaneseIndustry(html).industryCode, code);
  }
  assert.equal(parseYahooJapaneseIndustry('<div id="industry"><span class="industryName">情報&#x30fb;通信</span></div>').industryCode, "INFORMATION_COMMUNICATIONS");
  assert.equal(parseYahooJapaneseIndustry('<table><tr><th>業種分類</th><td>保険業</td></tr></table>').industryCode, "INSURANCE");
  for (const html of [null, "", "<p>特色: 保険業</p>", '<div id="industry"><span class="industryName">未知業種</span></div>',
    '<div id="industry"><span class="industryName">保険業</span></div><th>業種分類</th><td>情報・通信</td>',
    '<div id="industry"><span class="industryName">未知業種</span></div><th>業種分類</th><td>保険業</td>']) {
    assert.equal(parseYahooJapaneseIndustry(html), null);
  }
});
test("sensitivity uses sector rules, with a semiconductor override and null for unclassifiable sectors", () => {
  const expected = {
    MATERIALS: "CYCLICAL", INDUSTRIALS: "CYCLICAL", CONSUMER_DISCRETIONARY: "CYCLICAL",
    CONSUMER_STAPLES: "DEFENSIVE", HEALTH_CARE: "DEFENSIVE", UTILITIES: "DEFENSIVE",
    FINANCIALS: "NEUTRAL", INFORMATION_TECHNOLOGY: "NEUTRAL", COMMUNICATION_SERVICES: "NEUTRAL", REAL_ESTATE: "NEUTRAL", ENERGY: "NEUTRAL"
  };
  for (const [sector, sensitivity] of Object.entries(expected)) assert.equal(classifySensitivity(sector, null), sensitivity);
  assert.equal(classifySensitivity("INFORMATION_TECHNOLOGY", "SEMICONDUCTORS"), "CYCLICAL");
  assert.equal(classifySensitivity("FINANCIALS", "SEMICONDUCTORS"), "NEUTRAL");
  assert.equal(classifySensitivity(null, "SEMICONDUCTORS"), null);
  assert.equal(classifySensitivity("UNKNOWN", null), null);
});
