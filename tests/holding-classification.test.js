const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const root = path.resolve(__dirname, "..");
const fields = ["auto_sector_code", "user_sector_code", "auto_industry_code", "user_industry_code",
  "auto_fund_category_code", "user_fund_category_code", "auto_sensitivity_code", "user_sensitivity_code"];
const sample = {
  accounts: [{ id: "a", name: "分類テスト口座", note: "既存メモ" }],
  holdings: [
    { id: "us", accountId: "a", type: "米国株", currency: "USD", symbol: "NVDA", name: "NVIDIA", quantity: 2, cost: 100,
      auto_sector_code: "sector_test_1", user_sector_code: "sector_test_2", auto_industry_code: "industry_test_1", user_industry_code: "industry_test_2",
      auto_sensitivity_code: "sensitivity_test_1", user_sensitivity_code: "sensitivity_test_2" },
    { id: "jp", accountId: "a", type: "日本株", currency: "JPY", symbol: "8766.T", name: "東京海上", quantity: 10, cost: 500 },
    { id: "fund", accountId: "a", type: "投資信託", currency: "JPY", symbol: "03311187", name: "投信", quantity: 10000, cost: 40000,
      auto_fund_category_code: "fund_test_1", user_fund_category_code: "fund_test_2", auto_sensitivity_code: "sensitivity_test_1", user_sensitivity_code: "sensitivity_test_2" },
    { id: "etf", accountId: "a", type: "米国株", currency: "USD", symbol: "VOO", name: "ETF", quantity: 1, cost: 400,
      auto_fund_category_code: "fund_test_1", user_fund_category_code: "fund_test_2", auto_sensitivity_code: "sensitivity_test_1", user_sensitivity_code: "sensitivity_test_2" }
  ]
};

async function startApp(folder) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env,
    ASSET_COMPASS_DB_PATH: path.join(folder, "state.sqlite"), ASSET_COMPASS_PORT: String(port),
    ASSET_COMPASS_HOST: "127.0.0.1", ASSET_COMPASS_BIND_LAN: "false", ASSET_COMPASS_TRUST_PROXY: "false"
  }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; };
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + "/api/v1/state", { signal: AbortSignal.timeout(1000) })).ok) return { base, stop }; }
      catch { /* Starting. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Server did not start: " + output);
  } catch (error) { await stop(); throw error; }
}
async function read(base) { return (await fetch(base + "/api/v1/state")).json(); }
async function put(base, state, data, status = 200) {
  const response = await fetch(base + "/api/v1/state", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: state.revision, data }), signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test("classification codes survive API import, edits, legacy saves, cache and restart", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-classification-"));
  let app;
  t.after(async () => { if (app) await app.stop(); fs.rmSync(folder, { recursive: true, force: true }); });
  app = await startApp(folder);
  const imported = await fetch(app.base + "/api/v1/migrate-local-storage", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: JSON.parse(JSON.stringify(sample)) }) });
  assert.equal(imported.status, 201);
  let state = await imported.json();
  for (const holding of state.data.holdings) for (const field of fields) {
    assert.equal(holding[field], sample.holdings.find(h => h.id === holding.id)[field] ?? null);
  }
  const before = structuredClone(state.data);
  const changed = structuredClone(state.data);
  changed.holdings[2].user_fund_category_code = "HIGH_DIVIDEND";
  state = await put(app.base, state, changed);
  assert.equal(state.data.holdings[0].user_sector_code, "sector_test_2", "auto and user codes are independent");
  const legacy = structuredClone(state.data);
  for (const holding of legacy.holdings) for (const field of fields) delete holding[field];
  legacy.holdings[0].quantity = 3;
  state = await put(app.base, state, legacy);
  assert.equal(state.data.holdings[0].auto_sector_code, "sector_test_1");
  assert.equal(state.data.holdings[2].user_fund_category_code, "HIGH_DIVIDEND");
  const cleared = structuredClone(state.data);
  for (const field of fields.filter(field => field.startsWith("user_"))) cleared.holdings[0][field] = null;
  state = await put(app.base, state, cleared);
  for (const field of fields) assert.equal(state.data.holdings[0][field], field.startsWith("user_") ? null : sample.holdings[0][field] ?? null);
  const withNew = structuredClone(state.data);
  withNew.holdings.push({ id: "new", accountId: "a", type: "日本株", currency: "JPY", symbol: "9432", name: "NTT", quantity: 1, cost: 170 });
  state = await put(app.base, state, withNew);
  for (const field of fields) assert.equal(state.data.holdings.at(-1)[field], null);
  assert.deepEqual(state.data.accounts, before.accounts);
  assert.equal(state.data.holdings[1].symbol, "8766");
  assert.equal(state.data.holdings[1].cost, before.holdings[1].cost);

  // Execute the existing cache functions, without UI or classification logic.
  const storage = new Map();
  const context = vm.createContext({ localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    AssetCompassSymbols: require("../symbols"), window: { crypto: require("node:crypto").webcrypto }, payload: state,
    Intl, Uint8Array });
  const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf("function showSyncNotice")) +
    source.slice(source.indexOf("function applyServerState"), source.indexOf("async function requestServerState")) +
    "applyServerState(payload);", context);
  assert.deepEqual(JSON.parse(storage.get("asset-compass-v1")), state.data);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(readLocalData())", context)), state.data);

  await app.stop(); app = await startApp(folder);
  assert.deepEqual(await read(app.base), state);
});

test("invalid classification codes reject the whole save without changing stored data", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-classification-invalid-"));
  const app = await startApp(folder);
  t.after(async () => { await app.stop(); fs.rmSync(folder, { recursive: true, force: true }); });
  const importResponse = await fetch(app.base + "/api/v1/migrate-local-storage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: sample }) });
  assert.equal(importResponse.status, 201);
  const state = await read(app.base);
  for (const field of fields) for (const value of [42, false, {}, [], "", "Technology sector", "景気敏感", "x".repeat(129)]) {
    const invalid = structuredClone(state.data);
    invalid.accounts[0].name = "must not persist";
    invalid.holdings[0][field] = value;
    await put(app.base, state, invalid, 400);
    assert.deepEqual(await read(app.base), state);
  }
  const stale = structuredClone(state.data);
  stale.holdings[0].user_sector_code = "sector_test_4";
  await put(app.base, { ...state, revision: state.revision - 1 }, stale, 409);
  assert.deepEqual(await read(app.base), state);
});

test("instrument_kind migrates as nullable, persists through saves, preserves omission and rejects invalid values", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-instrument-kind-"));
  const app = await startApp(folder);
  t.after(async () => { await app.stop(); fs.rmSync(folder, { recursive: true, force: true }); });
  const holdings = [
    { id: "stock", accountId: "a", type: "米国株", currency: "USD", symbol: "NVDA", name: "Stock", quantity: 1, cost: 1, instrument_kind: "STOCK" },
    { id: "etf", accountId: "a", type: "米国株", currency: "USD", symbol: "SOXL", name: "ETF", quantity: 1, cost: 1, instrument_kind: "ETF" },
    { id: "unknown", accountId: "a", type: "日本株", currency: "JPY", symbol: "7203", name: "Unknown", quantity: 1, cost: 1 },
    { id: "fund", accountId: "a", type: "投資信託", currency: "JPY", symbol: "03311187", name: "Fund", quantity: 1, cost: 1 }
  ];
  const imported = await fetch(app.base + "/api/v1/migrate-local-storage", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { accounts: [{ id: "a", name: "口座" }], holdings } }) });
  assert.equal(imported.status, 201);
  let state = await imported.json();
  assert.deepEqual(state.data.holdings.map(holding => holding.instrument_kind), ["STOCK", "ETF", null, null]);
  const invalidValues = ["FUND", "stock", "", "UNKNOWN", 1, false];
  for (const value of invalidValues) {
    const invalid = structuredClone(state.data);
    invalid.holdings[0].instrument_kind = value;
    await put(app.base, state, invalid, 400);
  }
  const invalidFund = structuredClone(state.data);
  invalidFund.holdings[3].instrument_kind = "ETF";
  await put(app.base, state, invalidFund, 400);
  const omitted = structuredClone(state.data);
  delete omitted.holdings[1].instrument_kind;
  state = await put(app.base, state, omitted);
  assert.equal(state.data.holdings.find(holding => holding.id === "etf").instrument_kind, "ETF");
  const changedIdentity = structuredClone(state.data);
  const etf = changedIdentity.holdings.find(holding => holding.id === "etf");
  etf.symbol = "VOO";
  delete etf.instrument_kind;
  state = await put(app.base, state, changedIdentity);
  assert.equal(state.data.holdings.find(holding => holding.id === "etf").instrument_kind, null);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(folder, "state.sqlite"));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);
  const column = db.prepare("PRAGMA table_info(holdings)").all().find(item => item.name === "instrument_kind");
  assert.equal(column.notnull, 0);
  assert.throws(() => db.prepare("UPDATE holdings SET instrument_kind = 'FUND' WHERE id = 'stock'").run(), /CHECK constraint/);
  assert.throws(() => db.prepare("UPDATE holdings SET instrument_kind = 'ETF' WHERE id = 'fund'").run(), /CHECK constraint/);
  db.close();
});

function v4Database(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_state (singleton_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, initialized INTEGER NOT NULL, last_quote_fetched_at INTEGER, updated_at INTEGER NOT NULL);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE account_categories (code TEXT PRIMARY KEY, label TEXT NOT NULL, sort_order INTEGER NOT NULL, is_active INTEGER NOT NULL);
    CREATE TABLE holdings (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, account_category_code TEXT NOT NULL, type TEXT NOT NULL, currency TEXT NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL, quantity REAL NOT NULL, cost REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, quote_status TEXT NOT NULL, quote_attempted_at INTEGER, FOREIGN KEY (account_id) REFERENCES accounts(id), FOREIGN KEY (account_category_code) REFERENCES account_categories(code));
    CREATE TABLE holding_quotes (holding_id TEXT PRIMARY KEY, price REAL NOT NULL, previous_close REAL, price_timestamp INTEGER, price_date TEXT, FOREIGN KEY (holding_id) REFERENCES holdings(id));
    CREATE TABLE fx_rates (base_currency TEXT NOT NULL, quote_currency TEXT NOT NULL, rate REAL NOT NULL, price_timestamp INTEGER, PRIMARY KEY (base_currency, quote_currency));
    CREATE TABLE daily_asset_snapshots (snapshot_date TEXT PRIMARY KEY, total_value_jpy REAL, usd_jpy_rate REAL, saved_at INTEGER NOT NULL, holding_count INTEGER NOT NULL, valued_holding_count INTEGER NOT NULL, unpriced_holding_count INTEGER NOT NULL, quote_failure_count INTEGER NOT NULL, is_complete INTEGER NOT NULL);
    CREATE TABLE daily_account_snapshots (snapshot_date TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT NOT NULL, value_jpy REAL, holding_count INTEGER NOT NULL, valued_holding_count INTEGER NOT NULL, unpriced_holding_count INTEGER NOT NULL, PRIMARY KEY (snapshot_date, account_id), FOREIGN KEY (snapshot_date) REFERENCES daily_asset_snapshots(snapshot_date));
    INSERT INTO app_state VALUES (1, 17, 1, 1780000000000, 1780000001000);
    INSERT INTO accounts VALUES ('a', '既存口座', 'メモ', 1, 2);
    INSERT INTO account_categories VALUES ('specified', '特定口座', 30, 1);
    INSERT INTO holdings VALUES ('h', 'a', 'specified', '日本株', 'JPY', '東京海上', '8766.T', 10, 500, 3, 4, 'success', 1780000002000);
    INSERT INTO holding_quotes VALUES ('h', 520, 510, 1780000003000, NULL);
    INSERT INTO fx_rates VALUES ('USD', 'JPY', 150, 1780000004000);
    INSERT INTO daily_asset_snapshots VALUES ('2026-09-25', 5200, 150, 1780000005000, 1, 1, 0, 0, 1);
    INSERT INTO daily_account_snapshots VALUES ('2026-09-25', 'a', '既存口座', 5200, 1, 1, 0);
    PRAGMA user_version = 4;
  `);
  return db;
}
function migrate(file) {
  return spawnSync(process.execPath, ["-e", "require('./database').db.close()"], { cwd: root, env: { ...process.env, ASSET_COMPASS_DB_PATH: file } });
}

test("v4 migration adds nullable classification and instrument columns without rewriting existing rows", t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-v5-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, "state.sqlite");
  const original = v4Database(file);
  const tables = ["app_state", "accounts", "account_categories", "holdings", "holding_quotes", "fx_rates", "daily_asset_snapshots", "daily_account_snapshots"];
  const before = Object.fromEntries(tables.map(table => [table, original.prepare(`SELECT * FROM ${table}`).all()]));
  original.close();
  for (let run = 0; run < 2; run++) {
    const result = migrate(file);
    assert.equal(result.status, 0, result.stderr.toString());
    const db = new DatabaseSync(file);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      if (table === "holdings") for (const row of rows) {
        assert.equal(row.instrument_kind, null, "migration leaves the existing instrument kind unknown");
        delete row.instrument_kind;
        for (const field of fields) { assert.equal(row[field], null); delete row[field]; }
      }
      assert.deepEqual(rows, before[table]);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => db.prepare("UPDATE holdings SET auto_sector_code = ?").run("表示名"), /CHECK constraint/);
    db.close();
  }
});

test("failed v5 migration rolls back columns and schema version", t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-v5-rollback-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, "state.sqlite");
  const initial = v4Database(file);
  initial.exec("ALTER TABLE holdings ADD COLUMN user_sector_code TEXT");
  const columnsBefore = initial.prepare("PRAGMA table_info(holdings)").all();
  initial.close();
  const result = migrate(file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /duplicate column/);
  const db = new DatabaseSync(file);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
  assert.deepEqual(db.prepare("PRAGMA table_info(holdings)").all(), columnsBefore);
  assert.equal(db.prepare("SELECT revision FROM app_state").get().revision, 17);
  assert.equal(db.prepare("SELECT price FROM holding_quotes").get().price, 520);
  db.close();
});
