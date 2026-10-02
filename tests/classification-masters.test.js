const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const masters = require("../classification-masters");

const expected = {
  sector: {
    ENERGY: "エネルギー", MATERIALS: "素材", INDUSTRIALS: "資本財・サービス",
    CONSUMER_DISCRETIONARY: "一般消費財・サービス", CONSUMER_STAPLES: "生活必需品",
    HEALTH_CARE: "ヘルスケア", FINANCIALS: "金融", INFORMATION_TECHNOLOGY: "情報技術",
    COMMUNICATION_SERVICES: "コミュニケーション・サービス", UTILITIES: "公益事業", REAL_ESTATE: "不動産"
  },
  sensitivity: { CYCLICAL: "景気敏感", DEFENSIVE: "ディフェンシブ", NEUTRAL: "中立" },
  fundCategory: {
    BROAD_INDEX: "広範囲株式指数", NASDAQ_TECH: "NASDAQ・ハイテク", SEMICONDUCTOR: "半導体",
    AI_THEME: "AI・テクノロジーテーマ", HIGH_DIVIDEND: "高配当", COVERED_CALL: "カバードコール",
    REIT: "REIT・不動産", BOND: "債券", COMMODITY: "コモディティ", BALANCED: "バランス", OTHER: "その他"
  }
};
const groups = { sector: masters.sectors, sensitivity: masters.sensitivities, fundCategory: masters.fundCategories };

for (const [kind, entries] of Object.entries(groups)) {
  test(`${kind} defines every specified code and label with descriptions and examples`, () => {
    assert.equal(entries.length, kind === "sensitivity" ? 3 : 11);
    assert.equal(new Set(entries.map(entry => entry.code)).size, entries.length);
    assert.deepEqual(Object.fromEntries(entries.map(entry => [entry.code, entry.label])), expected[kind]);
    for (const entry of entries) {
      assert.match(entry.code, /^[A-Za-z0-9_.:-]{1,128}$/);
      assert.ok(entry.label.trim());
      assert.ok(entry.description.trim());
      assert.ok(Array.isArray(entry.examples) && entry.examples.length > 0);
      for (const example of entry.examples) assert.ok(typeof example === "string" && example.trim());
      assert.equal(masters.getEntry(kind, entry.code), entry);
      assert.equal(masters.getLabel(kind, entry.code), entry.label);
    }
  });
}

test("missing and unknown codes have no label and are not assigned to OTHER", () => {
  for (const kind of Object.keys(groups)) for (const code of [null, undefined, "", "UNKNOWN", "energy", "toString"]) {
    assert.equal(masters.getEntry(kind, code), null);
    assert.equal(masters.getLabel(kind, code), null);
  }
  assert.equal(masters.getLabel("unknown", "ENERGY"), null);
  assert.equal(masters.getLabel("industry", "Semiconductors"), null);
  assert.equal(masters.getLabel("fundCategory", "OTHER"), "その他");
});

test("effective code uses the user override, then automatic value, without assigning classifications", () => {
  const holding = {
    user_sector_code: "ENERGY", auto_sector_code: "INFORMATION_TECHNOLOGY",
    user_fund_category_code: null, auto_fund_category_code: "BROAD_INDEX",
    auto_sensitivity_code: "NEUTRAL", user_industry_code: "user-industry", auto_industry_code: "auto-industry"
  };
  const before = structuredClone(holding);
  assert.equal(masters.getEffectiveCode(holding, "sector"), "ENERGY");
  assert.equal(masters.getEffectiveCode(holding, "fundCategory"), "BROAD_INDEX");
  assert.equal(masters.getEffectiveCode(holding, "sensitivity"), "NEUTRAL");
  assert.equal(masters.getEffectiveCode(holding, "industry"), "user-industry");
  assert.equal(masters.getEffectiveCode({}, "sector"), null);
  assert.equal(masters.getEffectiveCode(null, "sector"), null);
  assert.equal(masters.getEffectiveCode(holding, "unknown"), null);
  assert.equal(masters.getEffectiveCode({ user_sector_code: "FUTURE_CODE", auto_sector_code: "ENERGY" }, "sector"), "FUTURE_CODE");
  assert.deepEqual(holding, before);
});

test("master arrays, entries and examples are immutable", () => {
  assert.ok(Object.isFrozen(masters));
  for (const entries of Object.values(groups)) {
    assert.ok(Object.isFrozen(entries));
    for (const entry of entries) {
      assert.ok(Object.isFrozen(entry));
      assert.ok(Object.isFrozen(entry.examples));
    }
  }
});

test("the same standalone module works in a browser context without CommonJS or a DOM", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../classification-masters.js"), "utf8"), context);
  const browser = context.AssetCompassClassificationMasters;
  assert.equal(browser.getLabel("sector", "INFORMATION_TECHNOLOGY"), "情報技術");
  assert.equal(browser.getLabel("sensitivity", "DEFENSIVE"), "ディフェンシブ");
  assert.equal(browser.getLabel("fundCategory", "COVERED_CALL"), "カバードコール");
  assert.equal(JSON.stringify(browser.sectors), JSON.stringify(masters.sectors));
  assert.equal(JSON.stringify(browser.sensitivities), JSON.stringify(masters.sensitivities));
  assert.equal(JSON.stringify(browser.fundCategories), JSON.stringify(masters.fundCategories));
});

test("all master codes persist through the existing SQLite schema and API state normalization", t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-master-codes-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const { sectors, sensitivities, fundCategories } = require('./classification-masters');
    const { db, migrateLocalState, getState, saveState } = require('./database');
    try {
      const holdings = [];
      for (const [field, entries] of [['sector', sectors], ['sensitivity', sensitivities], ['fund_category', fundCategories]]) {
        for (const entry of entries) holdings.push({
          id: field + entry.code, accountId: 'a', type: field === 'fund_category' ? '投資信託' : '米国株',
          currency: field === 'fund_category' ? 'JPY' : 'USD', name: 'テスト保有', symbol: 'TEST', quantity: 1, cost: 1,
          ['auto_' + field + '_code']: entry.code, ['user_' + field + '_code']: entry.code
        });
      }
      const imported = migrateLocalState({ accounts: [{ id: 'a', name: 'テスト口座' }], holdings }).state;
      const saved = saveState(imported.revision, imported.data).state;
      for (const expected of holdings) {
        const actual = saved.data.holdings.find(h => h.id === expected.id);
        for (const key of Object.keys(expected).filter(k => k.endsWith('_code'))) assert.equal(actual[key], expected[key]);
      }
      assert.deepEqual(getState(), saved);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    } finally { db.close(); }
  `], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, ASSET_COMPASS_DB_PATH: path.join(folder, "test.sqlite") } });
  assert.equal(result.status, 0, result.stderr.toString());
});
