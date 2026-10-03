const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const editor = require("../classification-editor");
const masters = require("../classification-masters");
const root = path.resolve(__dirname, "..");
const sample = {
  accounts: [{ id: "a", name: "テスト口座", note: "保持するメモ" }],
  holdings: [
    { id: "stock", accountId: "a", type: "米国株", currency: "USD", symbol: "NVDA", name: "NVDA", quantity: 2, cost: 100,
      price: 200, previousClose: 190, priceTimestamp: 1780000001000, quoteStatus: "success", quoteAttemptedAt: 1780000001000,
      auto_sector_code: "INFORMATION_TECHNOLOGY", auto_industry_code: "SEMICONDUCTORS", auto_sensitivity_code: "CYCLICAL" },
    { id: "fund", accountId: "a", type: "投資信託", currency: "JPY", symbol: "03311187", name: "投信", quantity: 10000, cost: 40000,
      auto_fund_category_code: "BROAD_INDEX", auto_sensitivity_code: "NEUTRAL" },
    { id: "etf", accountId: "a", type: "米国株", currency: "USD", symbol: "VOO", name: "ETF", quantity: 1, cost: 400,
      auto_fund_category_code: "BROAD_INDEX", auto_sensitivity_code: "NEUTRAL" }
  ], usdJpyRate: 150, usdJpyTimestamp: 1780000001000, lastQuoteFetchedAt: 1780000001000
};
async function start(folder) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env,
    ASSET_COMPASS_DB_PATH: path.join(folder, "state.sqlite"), ASSET_COMPASS_PORT: String(port), ASSET_COMPASS_HOST: "127.0.0.1",
    ASSET_COMPASS_TRUST_PROXY: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; };
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + "/api/v1/state", { signal: AbortSignal.timeout(1000) })).ok) return { base, stop }; }
      catch { /* Starting. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Server did not start: " + output);
  } catch (error) { await stop(); throw error; }
}
async function read(app) { return (await fetch(app.base + "/api/v1/state")).json(); }
async function put(app, state, data, expectedStatus = 200) {
  const response = await fetch(app.base + "/api/v1/state", { method: "PUT", headers: { "Content-Type": "application/json", Origin: app.base },
    body: JSON.stringify({ expectedRevision: state.revision, data }), signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, expectedStatus, await response.clone().text());
  return response.json();
}
async function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-edit-classification-"));
  const app = await start(folder);
  t.after(async () => { await app.stop(); fs.rmSync(folder, { recursive: true, force: true }); });
  const response = await fetch(app.base + "/api/v1/migrate-local-storage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: sample }) });
  assert.equal(response.status, 201);
  return { app, folder, state: await read(app) };
}

test("classification editing saves only user overrides, survives restart and restores automatic values through null", async t => {
  const { app, folder, state: imported } = await fixture(t);
  let state = imported;
  const data = editor.toSaveData(structuredClone(state.data));
  Object.assign(data.holdings[0], { user_sector_code: "ENERGY", user_industry_code: "SOFTWARE_INFRASTRUCTURE", user_sensitivity_code: "DEFENSIVE" });
  for (const holding of data.holdings.slice(1)) Object.assign(holding, { user_fund_category_code: "HIGH_DIVIDEND", user_sensitivity_code: "CYCLICAL" });
  state = await put(app, state, data);
  assert.equal(state.revision, imported.revision + 1);
  assert.equal(masters.getEffectiveCode(state.data.holdings[0], "sector"), "ENERGY");
  assert.equal(masters.getEffectiveCode(state.data.holdings[0], "industry"), "SOFTWARE_INFRASTRUCTURE");
  assert.equal(masters.getEffectiveCode(state.data.holdings[1], "fundCategory"), "HIGH_DIVIDEND");
  for (let i = 0; i < state.data.holdings.length; i++) {
    for (const field of editor.fields) assert.equal(state.data.holdings[i][field.auto], imported.data.holdings[i][field.auto]);
    const previous = { ...imported.data.holdings[i] }, current = { ...state.data.holdings[i] };
    for (const field of editor.fields) { delete previous[field.user]; delete current[field.user]; }
    assert.deepEqual(current, previous, "prices, quantity, cost and identity are preserved");
  }
  assert.deepEqual(state.data.accounts, imported.data.accounts);
  const response = await put(app, imported, editor.toSaveData(imported.data), 409);
  assert.equal(response.error, "revision_conflict");
  assert.deepEqual(await read(app), state);
  await app.stop();
  const restarted = await start(folder);
  try {
    assert.deepEqual(await read(restarted), state);
    const reset = editor.toSaveData(structuredClone(state.data));
    for (const holding of reset.holdings) for (const field of editor.fields) holding[field.user] = null;
    state = await put(restarted, state, reset);
    for (const holding of state.data.holdings) for (const field of editor.fields) {
      assert.equal(holding[field.user], null);
      assert.equal(masters.getEffectiveCode(holding, field.kind), holding[field.auto]);
    }
    assert.deepEqual(await read(restarted), state);
  } finally { await restarted.stop(); }
});

test("all automatic codes are protected against replacement/clearing, including auto values injected into new assets", async t => {
  const { app, state } = await fixture(t);
  for (const field of editor.fields) for (const value of [null, "ENERGY"]) {
    const data = structuredClone(state.data);
    const holding = field.kind === "fundCategory" ? data.holdings[1] : data.holdings[0];
    holding[field.auto] = value;
    data.accounts[0].name = "must not persist";
    await put(app, state, data, 400);
    assert.deepEqual(await read(app), state);
  }
  const injected = editor.toSaveData(structuredClone(state.data));
  injected.holdings.push({ ...sample.holdings[0], id: "new" });
  await put(app, state, injected, 400);
  assert.deepEqual(await read(app), state);
  // Current clients may still echo unchanged automatic values; old clients may omit all codes.
  const echoed = await put(app, state, state.data);
  const legacy = structuredClone(echoed.data);
  for (const holding of legacy.holdings) for (const field of editor.fields) { delete holding[field.auto]; delete holding[field.user]; }
  const saved = await put(app, echoed, legacy);
  assert.deepEqual(saved.data, echoed.data);
});

test("unknown master codes and malformed industry input reject atomic saves, including cross-field valid changes", async t => {
  const { app, state } = await fixture(t);
  for (const field of editor.fields) for (const value of ["", "wrong code", "日本語", 42, false, "x".repeat(129), ...(field.kind === "industry" ? ["SEMICONDUCTORS\n"] : ["INVALID_CODE", "energy"])]) {
    const data = editor.toSaveData(structuredClone(state.data));
    data.accounts[0].note = "must not persist";
    const holding = field.kind === "fundCategory" ? data.holdings[1] : data.holdings[0];
    holding.user_sensitivity_code = "DEFENSIVE";
    holding[field.user] = value;
    await put(app, state, data, 400);
    assert.deepEqual(await read(app), state);
  }
  for (const id of ["fund", "etf"]) for (const field of ["user_sector_code", "user_industry_code"]) {
    const data = editor.toSaveData(structuredClone(state.data));
    data.holdings.find(holding => holding.id === id)[field] = field === "user_sector_code" ? "ENERGY" : "SEMICONDUCTORS";
    await put(app, state, data, 400);
    assert.deepEqual(await read(app), state);
  }
});

test("new holdings accept valid user codes, and browser modules are served without exposing server-only classification services", async t => {
  const { app, state } = await fixture(t);
  const data = editor.toSaveData(structuredClone(state.data));
  data.holdings.push({ id: "jp", accountId: "a", type: "日本株", currency: "JPY", name: "東京海上", symbol: "8766", quantity: 1, cost: 500,
    user_sector_code: "FINANCIALS", user_industry_code: "INSURANCE", user_sensitivity_code: "NEUTRAL" });
  const saved = await put(app, state, data);
  assert.equal(saved.data.holdings.at(-1).user_sector_code, "FINANCIALS");
  assert.equal(saved.data.holdings.at(-1).auto_sector_code, null);
  for (const file of ["classification-masters.js", "classification-editor.js"]) assert.equal((await fetch(app.base + "/" + file)).status, 200);
  for (const file of ["classification-service.js", "classification-rules.js", "database.js"]) assert.equal((await fetch(app.base + "/" + file)).status, 404);
});

test("identity changes cannot inject automatic codes, while equivalent symbols preserve protected codes", async t => {
  const { app, state } = await fixture(t);
  for (const field of editor.fields) {
    const injected = editor.toSaveData(structuredClone(state.data));
    Object.assign(injected.holdings[0], { symbol: "MU", [field.auto]: field.kind === "fundCategory" ? "BROAD_INDEX" : field.kind === "sector" ? "ENERGY" : field.kind === "industry" ? "SEMICONDUCTORS" : "NEUTRAL" });
    await put(app, state, injected, 400);
    assert.deepEqual(await read(app), state);
  }
  const equivalent = editor.toSaveData(structuredClone(state.data));
  equivalent.holdings[0].symbol = "nvda";
  equivalent.holdings[0].currency = "JPY";
  const saved = await put(app, state, equivalent);
  for (const field of editor.fields) assert.equal(saved.data.holdings[0][field.auto], state.data.holdings[0][field.auto]);
  const clear = editor.toSaveData(structuredClone(saved.data));
  clear.holdings[0].auto_sector_code = null;
  await put(app, saved, clear, 400);
  assert.deepEqual(await read(app), saved);
});
