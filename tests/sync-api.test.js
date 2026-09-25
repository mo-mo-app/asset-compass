const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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
      { id: "holding-2", accountId: "account-1", type: "投資信託", currency: "JPY", name: "テスト投信", symbol: "12345678", quantity: 10000, cost: 10000, price: 10100, previousClose: 10000, priceTimestamp: null, priceDate: "9/25" }
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
  assert.equal(migrated.holdingsCount, 2);
  assert.equal(migrated.data.holdings[1].priceDate, "9/25");

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

  const staleData = structuredClone(migrated.data);
  staleData.accounts[0].name = "古い端末からの上書き";
  const conflictResponse = await fetch(`${base}/api/v1/state`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, data: staleData })
  });
  assert.equal(conflictResponse.status, 409);
  const afterConflict = await (await fetch(`${base}/api/v1/state`)).json();
  assert.equal(afterConflict.revision, 2);
  assert.equal(afterConflict.data.accounts[0].name, "SBI証券（更新）");

  const rejectedOrigin = await fetch(`${base}/api/v1/state`, {
    method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://untrusted.example" },
    body: JSON.stringify({ expectedRevision: 2, data: saved.data })
  });
  assert.equal(rejectedOrigin.status, 403);
  await stopServer();

  assert.equal(fs.existsSync(dbPath), true);
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  const tableCount = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('app_state','accounts','holdings','holding_quotes','fx_rates')").get().count;
  assert.equal(tableCount, 5);
  assert.equal(db.prepare("PRAGMA foreign_key_list(holdings)").all().some(row => row.table === "accounts" && row.from === "account_id"), true);
  assert.equal(db.prepare("PRAGMA foreign_key_list(holding_quotes)").all().some(row => row.table === "holdings" && row.from === "holding_id"), true);
  db.close();

  await startServer();
  const afterRestart = await (await fetch(`${base}/api/v1/state`)).json();
  assert.equal(afterRestart.revision, 2);
  assert.equal(afterRestart.data.usdJpyRate, 159.82);
  assert.equal(afterRestart.data.holdings[0].quantity, 3);
  const repeatMigration = await fetch(`${base}/api/v1/migrate-local-storage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: localData })
  });
  assert.equal(repeatMigration.status, 409);
});
