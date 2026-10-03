const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

test("state API enforces new numeric precision while preserving unchanged legacy values and SQLite schema", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-number-"));
  const dbPath = path.join(folder, "test.sqlite");
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], {
    env: { ...process.env, ASSET_COMPASS_DB_PATH: dbPath, ASSET_COMPASS_PORT: String(port), ASSET_COMPASS_BIND_LAN: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  t.after(async () => {
    if (child.exitCode === null) {
      const exit = new Promise(resolve => child.once("exit", resolve));
      child.kill(); await exit;
    }
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${base}/api/v1/state`)).ok) { ready = true; break; } } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, output);
  assert.equal((await fetch(`${base}/holding-number-rules.js`)).status, 200, "shared browser module must be served");
  const imported = await fetch(`${base}/api/v1/migrate-local-storage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: {
      accounts: [{ id: "a", name: "口座" }], holdings: [{ id: "legacy", accountId: "a", accountCategoryCode: "specified",
        type: "米国株", currency: "USD", symbol: "AAPL", name: "Legacy", quantity: 1.123456, cost: 12.123456, price: null },
      { id: "legacy-ideco", accountId: "a", accountCategoryCode: "ideco", type: "投資信託", currency: "JPY",
        symbol: "12345678", name: "Legacy iDeCo", quantity: 10000, cost: 1.5, price: null }]
    } })
  });
  assert.equal(imported.status, 201);
  let current = await imported.json();
  async function save(data, expected = 200) {
    const response = await fetch(`${base}/api/v1/state`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: current.revision, data })
    });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    if (expected === 200) current = body;
  }
  let data = structuredClone(current.data);
  data.holdings[1].name = "旧iDeCoの名称のみ変更";
  await save(data);
  assert.equal(current.data.holdings[1].quantity, 10000);
  assert.equal(current.data.holdings[1].cost, 1.5, "unchanged out-of-rule legacy iDeCo pair remains intact");
  data = structuredClone(current.data);
  data.holdings[1].quantity = 10001;
  await save(data, 400);
  data = structuredClone(current.data);
  data.holdings[1].cost = 1.5001;
  await save(data, 400);
  data = structuredClone(current.data);
  data.holdings[1].cost = 2;
  await save(data);
  assert.equal(current.data.holdings[1].cost, 2, "changed legacy iDeCo pair can be corrected to whole yen");
  data = structuredClone(current.data);
  data.holdings[0].name = "名前のみ変更";
  data.holdings[0].accountCategoryCode = "nisa_growth";
  data.accounts.push({id: "b", name: "移管先"}); data.holdings[0].accountId = "b";
  await save(data);
  assert.equal(current.data.holdings[0].quantity, 1.123456);
  assert.equal(current.data.holdings[0].cost, 12.123456);
  for (const [field, value] of [["quantity", 1.12345], ["cost", 12.12345]]) {
    data = structuredClone(current.data); data.holdings[0][field] = value; await save(data, 400);
  }
  for (const [field, value] of [["symbol", "MSFT"], ["currency", "JPY"], ["type", "日本株"]]) {
    data = structuredClone(current.data); data.holdings[0][field] = value; await save(data, 400);
  }
  // New payloads bypassing the UI must still obey every type/currency rule.
  for (const [type, currency, category, field, value] of [
    ["日本株", "JPY", "specified", "quantity", 100.5], ["日本株", "JPY", "specified", "cost", 100.123],
    ["米国株", "USD", "specified", "quantity", 1.12345], ["米国株", "USD", "specified", "cost", 100.12345],
    ["米国株", "JPY", "specified", "cost", 100.123], ["投資信託", "JPY", "specified", "quantity", 10000.5],
    ["投資信託", "JPY", "specified", "cost", 10000.5], ["投資信託", "JPY", "ideco", "quantity", 10000.5],
    ["日本株", "JPY", "specified", "quantity", 0], ["日本株", "JPY", "specified", "cost", -1],
    ["米国株", "USD", "specified", "quantity", 1e20]
  ]) {
    data = structuredClone(current.data);
    data.holdings.push({ id: "new", accountId: "a", accountCategoryCode: category, type, currency, symbol: "9I311181",
      name: "New", quantity: 10000, cost: 10000, price: null, [field]: value });
    await save(data, 400);
  }
  data = structuredClone(current.data);
  data.holdings.push({ id: "fractional-ideco", accountId: "a", accountCategoryCode: "ideco", type: "投資信託", currency: "JPY",
    symbol: "87654321", name: "Fractional iDeCo", quantity: 10000, cost: 1.5, price: null });
  await save(data, 400);

  data = structuredClone(current.data);
  data.holdings.push({ id: "fractional-ideco-extreme", accountId: "a", accountCategoryCode: "ideco", type: "投資信託", currency: "JPY",
    symbol: "87654322", name: "Fractional iDeCo at maximum quantity", quantity: Number.MAX_SAFE_INTEGER,
    cost: 1.001 / Number.MAX_SAFE_INTEGER * 10000, price: null });
  await save(data, 400);

  data = structuredClone(current.data);
  data.holdings[0].quantity = 1.1234; data.holdings[0].cost = 12.1234;
  data.holdings.push({ id: "ideco", accountId: "a", accountCategoryCode: "ideco", type: "投資信託", currency: "JPY",
    symbol: "9I311181", name: "iDeCo", quantity: 163067, cost: 273948 / 163067 * 10000, price: null });
  await save(data);
  data = structuredClone(current.data);
  data.holdings.find(holding => holding.id === "ideco").quantity = 163068;
  await save(data, 400);
  data = structuredClone(current.data);
  data.holdings.find(holding => holding.id === "ideco").quantity = 326134;
  await save(data);
  data = structuredClone(current.data);
  data.holdings.find(holding => holding.id === "ideco").cost += 0.01;
  await save(data, 400);
  const persisted = await (await fetch(`${base}/api/v1/state`)).json();
  assert.equal(persisted.data.holdings[0].quantity, 1.1234);
  assert.equal(persisted.data.holdings.find(holding => holding.id === "ideco").quantity, 326134);
  assert.equal(persisted.data.holdings.find(holding => holding.id === "ideco").cost, 273948 / 163067 * 10000);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
  assert.equal(db.prepare("SELECT cost FROM holdings WHERE id='ideco'").get().cost, 273948 / 163067 * 10000);
  db.close();
});
