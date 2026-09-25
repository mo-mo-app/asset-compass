const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { after, test } = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const serverPath = path.join(projectRoot, "server.js");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-v02-"));
const dbPath = path.join(tempDir, "asset-compass.sqlite");
let port;
let child;
let childOutput = "";

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port: availablePort } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return availablePort;
}

async function startServer() {
  if (port === undefined) port = await reservePort();
  childOutput = "";
  child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: { ...process.env, ASSET_COMPASS_DB_PATH: dbPath, ASSET_COMPASS_PORT: String(port), ASSET_COMPASS_BIND_LAN: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8").on("data", chunk => childOutput += chunk);
  child.stderr.setEncoding("utf8").on("data", chunk => childOutput += chunk);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup.\n${childOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/state`);
      if (response.ok) return;
    } catch { /* Wait for the listener to start. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start in time.\n${childOutput}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
  child = null;
}

after(async () => {
  await stopServer();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("SQLite state API migrates once, saves by revision, rejects stale writes, and persists across restart", async () => {
  await startServer();
  const base = `http://127.0.0.1:${port}`;
  const initialResponse = await fetch(`${base}/api/v1/state`);
  const initial = await initialResponse.json();
  assert.equal(initial.initialized, false);
  assert.equal(initial.revision, 0);
  assert.equal(initial.data.usdJpyRate, null);
  assert.equal(initial.data.lastQuoteFetchedAt, null);
  assert.equal(initialResponse.headers.get("access-control-allow-origin"), null);

  const localData = {
    accounts: [{ id: "account-1", name: "SBI証券", note: "NISA" }],
    holdings: [
      { id: "holding-1", accountId: "account-1", type: "米国株", currency: "USD", name: "Apple", symbol: "AAPL", quantity: 2, cost: 180, price: 190, previousClose: 188, priceTimestamp: 1780000000000, priceDate: null },
      { id: "holding-2", accountId: "account-1", type: "投資信託", currency: "JPY", name: "テスト投信", symbol: "12345678", quantity: 10000, cost: 10000, price: 10100, previousClose: 10000, priceTimestamp: null, priceDate: "9/25" },
      { id: "holding-3", accountId: "account-1", type: "日本株", currency: "JPY", name: "未取得銘柄", symbol: "9999.T", quantity: 10, cost: 1000, price: null, previousClose: null, priceTimestamp: null, priceDate: null }
    ],
    usdJpyRate: 159.82,
    usdJpyTimestamp: 1780000000000,
    lastQuoteFetchedAt: 1780000001000
  };
  const migrationResponse = await fetch(`${base}/api/v1/migrate-local-storage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: localData })
  });
  const migrated = await migrationResponse.json();
  assert.equal(migrationResponse.status, 201);
  assert.equal(migrated.revision, 1);
  assert.equal(migrated.accountsCount, 1);
  assert.equal(migrated.holdingsCount, 3);
  assert.equal(migrated.data.holdings[1].priceDate, "9/25");
  assert.equal(migrated.data.holdings[0].previousClose, null, "legacy fallback values are unverified");
  assert.equal(migrated.data.holdings[0].quoteStatus, "unknown");

  const newData = structuredClone(migrated.data);
  newData.accounts[0].name = "SBI証券（更新）";
  newData.holdings[0].quantity = 3;
  const saveResponse = await fetch(`${base}/api/v1/state`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, data: newData })
  });
  const saved = await saveResponse.json();
  assert.equal(saveResponse.status, 200);
  assert.equal(saved.revision, 2);
  assert.equal(saved.data.accounts[0].name, "SBI証券（更新）");
  assert.equal(saved.data.holdings[0].quantity, 3);

  const noSnapshotDb = new DatabaseSync(dbPath);
  assert.equal(noSnapshotDb.prepare("SELECT count(*) AS count FROM daily_asset_snapshots").get().count, 0, "ordinary account/holding saves must not create snapshots");
  noSnapshotDb.close();

  const partialData = structuredClone(saved.data);
  partialData.holdings[0].quoteStatus = "failed";
  partialData.holdings[0].quoteAttemptedAt = 1780000002000;
  partialData.holdings[2].quoteStatus = "failed";
  partialData.holdings[2].quoteAttemptedAt = 1780000002000;
  const partialSnapshotResponse = await fetch(`${base}/api/v1/state`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 2, data: partialData, snapshot: { quoteFailureCount: 1 } })
  });
  const partialSnapshot = await partialSnapshotResponse.json();
  assert.equal(partialSnapshotResponse.status, 200);
  assert.equal(partialSnapshot.revision, 3);
  assert.equal(partialSnapshot.snapshot.unpricedHoldingCount, 1);
  assert.equal(partialSnapshot.snapshot.quoteFailureCount, 1);
  assert.equal(partialSnapshot.snapshot.isComplete, false);
  assert.equal(partialSnapshot.snapshot.holdingCount, 3);
  assert.equal(partialSnapshot.data.holdings[0].quoteStatus, "failed");
  assert.equal(partialSnapshot.data.holdings[0].price, 190);
  assert.equal(partialSnapshot.data.holdings[0].priceTimestamp, 1780000000000);
  assert.equal(partialSnapshot.data.holdings[2].quoteStatus, "failed", "failure without an existing price must also persist");
  assert.equal(partialSnapshot.data.holdings[2].price, null);

  const completeData = structuredClone(partialSnapshot.data);
  completeData.holdings.forEach(h => { h.quoteStatus = "success"; h.quoteAttemptedAt = 1780000003000; });
  completeData.holdings[0].previousClose = 190; // A real unchanged quote.
  completeData.holdings[1].previousClose = null; // Price can succeed without comparison data.
  completeData.holdings[2].price = 2500;
  completeData.holdings[2].previousClose = 2450;
  completeData.holdings[2].priceTimestamp = 1780000000000;
  const completeSnapshotResponse = await fetch(`${base}/api/v1/state`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 3, data: completeData, snapshot: { quoteFailureCount: 0 } })
  });
  const completeSnapshot = await completeSnapshotResponse.json();
  assert.equal(completeSnapshotResponse.status, 200);
  assert.equal(completeSnapshot.revision, 4);
  assert.equal(completeSnapshot.snapshot.isComplete, true);
  assert.equal(completeSnapshot.snapshot.unpricedHoldingCount, 0);
  assert.equal(completeSnapshot.snapshot.snapshotDate, new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));

  const snapshotDb = new DatabaseSync(dbPath);
  const dailySnapshot = snapshotDb.prepare("SELECT * FROM daily_asset_snapshots").get();
  assert.equal(snapshotDb.prepare("SELECT count(*) AS count FROM daily_asset_snapshots").get().count, 1, "same-day snapshots must upsert");
  assert.equal(dailySnapshot.is_complete, 1);
  assert.equal(dailySnapshot.quote_failure_count, 0);
  assert.ok(Math.abs(dailySnapshot.total_value_jpy - (190 * 3 * 159.82 + 10100 + 2500 * 10)) < 0.001);
  const accountSnapshot = snapshotDb.prepare("SELECT * FROM daily_account_snapshots WHERE snapshot_date = ? AND account_id = ?").get(dailySnapshot.snapshot_date, "account-1");
  assert.equal(accountSnapshot.account_name, "SBI証券（更新）");
  assert.equal(accountSnapshot.valued_holding_count, 3);
  assert.ok(Math.abs(accountSnapshot.value_jpy - dailySnapshot.total_value_jpy) < 0.001);
  snapshotDb.close();

  const rangeDb = new DatabaseSync(dbPath);
  const addAssetSnapshot = rangeDb.prepare(`
    INSERT INTO daily_asset_snapshots (
      snapshot_date, total_value_jpy, usd_jpy_rate, saved_at, holding_count,
      valued_holding_count, unpriced_holding_count, quote_failure_count, is_complete
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addAccountSnapshot = rangeDb.prepare(`
    INSERT INTO daily_account_snapshots (
      snapshot_date, account_id, account_name, value_jpy, holding_count,
      valued_holding_count, unpriced_holding_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  addAssetSnapshot.run("2099-01-03", 300, 150, 4070995200000, 1, 1, 0, 0, 1);
  addAssetSnapshot.run("2099-01-01", null, null, 4070822400000, 1, 0, 1, 1, 0);
  addAssetSnapshot.run("2099-01-02", 200, 151, 4070908800000, 1, 1, 0, 0, 1);
  addAccountSnapshot.run("2099-01-03", "account-1", "口座 3", 300, 1, 1, 0);
  addAccountSnapshot.run("2099-01-01", "account-1", "口座 1", null, 1, 0, 1);
  addAccountSnapshot.run("2099-01-02", "account-1", "口座 2", 200, 1, 1, 0);
  rangeDb.close();

  const rangeResponse = await fetch(`${base}/api/v1/snapshots?from=2099-01-01&to=2099-01-02`);
  const rangeResult = await rangeResponse.json();
  assert.equal(rangeResponse.status, 200);
  assert.deepEqual(rangeResult.snapshots.map(snapshot => snapshot.date), ["2099-01-01", "2099-01-02"]);
  assert.equal(rangeResult.snapshots[0].totalValueJpy, null);
  assert.equal(rangeResult.snapshots[0].isComplete, false);
  assert.equal(typeof rangeResult.snapshots[1].isComplete, "boolean");
  assert.deepEqual(rangeResult.snapshots.map(snapshot => snapshot.accounts[0].accountName), ["口座 1", "口座 2"]);
  assert.equal(rangeResult.snapshots[0].accounts[0].valueJpy, null);

  const fullRange = await (await fetch(`${base}/api/v1/snapshots?from=2099-01-01&to=2099-01-03`)).json();
  assert.deepEqual(fullRange.snapshots.map(snapshot => snapshot.date), ["2099-01-01", "2099-01-02", "2099-01-03"]);
  const emptyRange = await fetch(`${base}/api/v1/snapshots?from=2098-01-01&to=2098-01-03`);
  assert.equal(emptyRange.status, 200);
  assert.deepEqual((await emptyRange.json()).snapshots, []);
  for (const invalidUrl of [
    `${base}/api/v1/snapshots?from=2026-9-01`,
    `${base}/api/v1/snapshots?to=2026-02-30`,
    `${base}/api/v1/snapshots?from=2026-09-27&to=2026-09-26`
  ]) {
    assert.equal((await fetch(invalidUrl)).status, 400);
  }
  const defaultRange = await (await fetch(`${base}/api/v1/snapshots`)).json();
  assert.equal(defaultRange.to, new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  assert.equal((Date.parse(`${defaultRange.to}T00:00:00Z`) - Date.parse(`${defaultRange.from}T00:00:00Z`)) / 86400000, 89);

  const staleData = structuredClone(migrated.data);
  staleData.accounts[0].name = "古い端末からの上書き";
  const conflictResponse = await fetch(`${base}/api/v1/state`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, data: staleData, snapshot: { quoteFailureCount: 0 } })
  });
  assert.equal(conflictResponse.status, 409);
  const afterConflict = await (await fetch(`${base}/api/v1/state`)).json();
  assert.equal(afterConflict.revision, 4);
  assert.equal(afterConflict.data.accounts[0].name, "SBI証券（更新）");
  const conflictDb = new DatabaseSync(dbPath);
  assert.equal(conflictDb.prepare("SELECT count(*) AS count FROM daily_asset_snapshots").get().count, 4, "conflict must not add a snapshot");
  conflictDb.close();

  const rejectedOrigin = await fetch(`${base}/api/v1/state`, {
    method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://untrusted.example" },
    body: JSON.stringify({ expectedRevision: 4, data: completeSnapshot.data })
  });
  assert.equal(rejectedOrigin.status, 403);
  await stopServer();

  assert.equal(fs.existsSync(dbPath), true);
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
  const tableCount = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('app_state','accounts','holdings','holding_quotes','fx_rates')").get().count;
  assert.equal(tableCount, 5);
  assert.equal(db.prepare("PRAGMA foreign_key_list(holdings)").all().some(row => row.table === "accounts" && row.from === "account_id"), true);
  assert.equal(db.prepare("PRAGMA foreign_key_list(holding_quotes)").all().some(row => row.table === "holdings" && row.from === "holding_id"), true);
  assert.equal(db.prepare("SELECT count(*) AS count FROM daily_asset_snapshots").get().count, 4);
  assert.equal(db.prepare("PRAGMA foreign_key_list(daily_account_snapshots)").all().some(row => row.table === "daily_asset_snapshots" && row.from === "snapshot_date"), true);
  db.close();

  await startServer();
  const afterRestart = await (await fetch(`${base}/api/v1/state`)).json();
  assert.equal(afterRestart.revision, 4);
  assert.equal(afterRestart.data.usdJpyRate, 159.82);
  assert.equal(afterRestart.data.holdings[0].quantity, 3);
  assert.equal(afterRestart.data.holdings[0].previousClose, 190);
  assert.equal(afterRestart.data.holdings[0].quoteStatus, "success");
  assert.equal(afterRestart.data.holdings[0].quoteAttemptedAt, 1780000003000);
  assert.equal(afterRestart.data.holdings[1].previousClose, null);
  const persistedSnapshots = new DatabaseSync(dbPath);
  assert.equal(persistedSnapshots.prepare("SELECT count(*) AS count FROM daily_asset_snapshots").get().count, 4);
  persistedSnapshots.close();
  const repeatMigration = await fetch(`${base}/api/v1/migrate-local-storage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: localData })
  });
  assert.equal(repeatMigration.status, 409);

  await stopServer();
  const legacyDbPath = path.join(tempDir, "legacy-v1.sqlite");
  const legacyDb = new DatabaseSync(legacyDbPath);
  legacyDb.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_state (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), revision INTEGER NOT NULL, initialized INTEGER NOT NULL, last_quote_fetched_at INTEGER, updated_at INTEGER NOT NULL);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE holdings (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL, currency TEXT NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL, quantity REAL NOT NULL, cost REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (account_id) REFERENCES accounts(id));
    CREATE TABLE holding_quotes (holding_id TEXT PRIMARY KEY, price REAL NOT NULL, previous_close REAL, price_timestamp INTEGER, price_date TEXT, FOREIGN KEY (holding_id) REFERENCES holdings(id));
    CREATE TABLE fx_rates (base_currency TEXT NOT NULL, quote_currency TEXT NOT NULL, rate REAL NOT NULL, price_timestamp INTEGER, PRIMARY KEY (base_currency, quote_currency));
    INSERT INTO app_state VALUES (1, 7, 1, NULL, 1780000000000);
    INSERT INTO accounts VALUES ('legacy-account', '既存口座', '', 1, 1);
    INSERT INTO holdings VALUES ('legacy-holding', 'legacy-account', '日本株', 'JPY', '旧銘柄', '7203.T', 1, 90, 1, 1);
    INSERT INTO holding_quotes VALUES ('legacy-holding', 100, 100, 1780000000000, NULL);
    PRAGMA user_version = 1;
  `);
  legacyDb.close();
  const migrationRun = spawnSync(process.execPath, ["-e", "require('./database')"], {
    cwd: projectRoot,
    env: { ...process.env, ASSET_COMPASS_DB_PATH: legacyDbPath }
  });
  assert.equal(migrationRun.status, 0, migrationRun.stderr.toString());
  const upgradedDb = new DatabaseSync(legacyDbPath);
  assert.equal(upgradedDb.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(upgradedDb.prepare("SELECT name FROM accounts WHERE id = 'legacy-account'").get().name, "既存口座");
  assert.equal(upgradedDb.prepare("SELECT revision FROM app_state WHERE singleton_id = 1").get().revision, 8);
  assert.equal(upgradedDb.prepare("SELECT price FROM holding_quotes").get().price, 100);
  assert.equal(upgradedDb.prepare("SELECT previous_close FROM holding_quotes").get().previous_close, null);
  assert.equal(upgradedDb.prepare("SELECT quote_status FROM holdings").get().quote_status, "unknown");
  assert.equal(upgradedDb.prepare("SELECT count(*) AS count FROM daily_asset_snapshots").get().count, 0);
  upgradedDb.close();
});

test("v2 upgrade preserves valuations and snapshots, invalidates legacy comparisons and stale revisions only once", () => {
  const upgradePath = path.join(tempDir, "legacy-v2.sqlite");
  const runDatabase = source => spawnSync(process.execPath, ["-e", source], {
    cwd: projectRoot, env: { ...process.env, ASSET_COMPASS_DB_PATH: upgradePath }
  });
  const seed = runDatabase(`
    const { db, migrateLocalState, saveState } = require('./database');
    const state = migrateLocalState({
      accounts: [{ id: 'a', name: '口座' }],
      holdings: [{ id: 'h', accountId: 'a', name: '銘柄', symbol: '7203.T', type: '日本株', currency: 'JPY', quantity: 2, cost: 90, price: 100 }]
    }).state;
    saveState(state.revision, state.data, { quoteFailureCount: 0 });
    db.close();
  `);
  assert.equal(seed.status, 0, seed.stderr.toString());
  const legacy = new DatabaseSync(upgradePath);
  legacy.exec(`
    ALTER TABLE holdings DROP COLUMN quote_status;
    ALTER TABLE holdings DROP COLUMN quote_attempted_at;
    UPDATE holding_quotes SET previous_close = price;
    PRAGMA user_version = 2;
  `);
  const revisionBefore = legacy.prepare("SELECT revision FROM app_state").get().revision;
  const snapshotBefore = legacy.prepare("SELECT * FROM daily_asset_snapshots").get();
  legacy.close();
  for (let run = 0; run < 2; run++) {
    const result = runDatabase("require('./database').db.close()");
    assert.equal(result.status, 0, result.stderr.toString());
    const upgraded = new DatabaseSync(upgradePath);
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(upgraded.prepare("SELECT revision FROM app_state").get().revision, revisionBefore + 1);
    assert.equal(upgraded.prepare("SELECT price FROM holding_quotes").get().price, 100);
    assert.equal(upgraded.prepare("SELECT previous_close FROM holding_quotes").get().previous_close, null);
    assert.deepEqual(upgraded.prepare("SELECT * FROM daily_asset_snapshots").get(), snapshotBefore);
    upgraded.close();
  }
});
