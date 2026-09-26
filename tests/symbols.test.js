const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { normalizeStoredSymbol, toQuoteSymbol, displaySymbol, sameHoldingSlot } = require("../symbols");

const root = path.resolve(__dirname, "..");

test("Japanese symbols use a canonical stored/display code and a Yahoo quote code", () => {
  for (const input of ["9432", "9432.T", "9432.t"]) {
    assert.equal(normalizeStoredSymbol("日本株", input), "9432");
    assert.equal(displaySymbol("日本株", input), "9432");
    assert.equal(toQuoteSymbol("日本株", input), "9432.T");
  }
  assert.equal(normalizeStoredSymbol("日本株", "563a.T"), "563A");
  assert.equal(toQuoteSymbol("日本株", "563A"), "563A.T");
  assert.equal(toQuoteSymbol("米国株", "MU"), "MU");
  assert.equal(displaySymbol("投資信託", "29313233"), "29313233");
});

function appContext(holdings) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: "", textContent: "", innerHTML: "", options: [],
      reset() {}, showModal() {},
      replaceChildren(...options) { this.options = options; },
      add(option) { this.options.push(option); }
    });
    return elements.get(selector);
  };
  const requested = [];
  const context = vm.createContext({
    Intl, console, window: { innerWidth: 1200 },
    fetch: async url => {
      requested.push(url);
      return { ok: true, json: async () => url.startsWith("/api/name")
        ? { name: "日本電信電話" }
        : { price: 100, previousClose: 95, priceTimestamp: 1234567890000 } };
    },
    localStorage: { getItem: () => JSON.stringify({
      accounts: [{ id: "account", name: "SBI証券" }],
      accountCategories: [
        { code: "unassigned", label: "未設定", sortOrder: 90 },
        { code: "nisa_growth", label: "NISA成長", sortOrder: 20 }
      ],
      holdings
    }) },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    document: {
      querySelector: element,
      createElement: () => ({
        set textContent(value) { this.text = String(value ?? ""); },
        get innerHTML() { return this.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
      })
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "symbols.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener("click"')), context);
  return { context, element, requested };
}

test("legacy and new Japanese holdings share display, sort, duplicate and heatmap identities", async () => {
  const old = {
    id: "old", accountId: "account", accountCategoryCode: "unassigned", type: "日本株",
    currency: "JPY", name: "NTT", symbol: "9432.T", quantity: 1, cost: 90,
    price: 100, previousClose: 95, quoteStatus: "success"
  };
  const { context, element, requested } = appContext([old]);
  context.openHolding("old");
  assert.equal(element("#holding-symbol").value, "9432");
  assert.match(context.holdingRow(old), /9432 · SBI証券/);
  assert.match(context.dashboardHoldingRow(old), /9432 · SBI証券/);
  assert.doesNotMatch(context.holdingRow(old), /9432\.T/);
  assert.equal(sameHoldingSlot(old, { ...old, symbol: "9432.t" }), true);
  assert.equal(sameHoldingSlot(old, { ...old, accountCategoryCode: "nisa_growth", symbol: "9432" }), false);

  const groups = context.groupHeatmapHoldings([old, { ...old, id: "new", symbol: "9432", accountCategoryCode: "nisa_growth" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].valueJpy, 200);
  assert.doesNotMatch(context.renderHeatmapTiles(groups), /9432\.T/);
  assert.doesNotMatch(context.renderHeatmapTreemap(groups), /9432\.T/);
  const sorted = context.sortHoldingsForList(["9434.T", "9432", "200A.T", "8766.T"].map((symbol, index) => ({ ...old, id: String(index), symbol })));
  assert.deepEqual(Array.from(sorted, item => displaySymbol(item.holding.type, item.holding.symbol)), ["200A", "8766", "9432", "9434"]);

  element("#holding-symbol").value = "9432";
  await context.lookupHoldingName();
  assert.match(requested.at(-1), /^\/api\/name\?symbol=9432&type=/);
  assert.equal(element("#holding-name").value, "日本電信電話");
  await context.updateQuote({ ...old });
  assert.match(requested.at(-1), /^\/api\/quote\?symbol=9432&type=/);
});

test("quote and name APIs add .T only for Yahoo requests", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-symbols-"));
  const preload = path.join(temp, "mock-yahoo.cjs");
  fs.writeFileSync(preload, `
    globalThis.fetch = async url => {
      const address = String(url);
      if (address.startsWith("https://query1.finance.yahoo.com/")) {
        if (!address.includes("/9432.T?")) throw new Error("Yahoo chart received " + address);
        return { ok: true, json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 100 } }] } }) };
      }
      if (address.startsWith("https://finance.yahoo.co.jp/")) {
        if (!address.endsWith("/9432.T")) throw new Error("Yahoo name received " + address);
        return { ok: true, text: async () => "<title>日本電信電話(株)【9432】：株価 - Yahoo!ファイナンス</title>" };
      }
      throw new Error("Unexpected request " + address);
    };
  `);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ["--require", preload, path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, ASSET_COMPASS_DB_PATH: path.join(temp, "state.sqlite"), ASSET_COMPASS_PORT: String(port), ASSET_COMPASS_BIND_LAN: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try { ready = (await fetch(`${base}/api/v1/state`)).ok; } catch { /* starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, output);
    const browserSymbols = await fetch(`${base}/symbols.js`);
    assert.equal(browserSymbols.status, 200);
    assert.match(await browserSymbols.text(), /AssetCompassSymbols/);
    const imported = await fetch(`${base}/api/v1/migrate-local-storage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: {
        accounts: [{ id: "account", name: "SBI証券", note: "" }],
        holdings: [{ id: "holding", accountId: "account", accountCategoryCode: "unassigned", type: "日本株",
          currency: "JPY", name: "NTT", symbol: "9432", quantity: 1, cost: 90,
          price: 100, previousClose: 95, quoteStatus: "success" }]
      } })
    });
    assert.equal(imported.status, 201);
    const importedState = await imported.json();
    assert.equal(importedState.data.holdings[0].symbol, "9432");
    const legacyPut = structuredClone(importedState.data);
    legacyPut.holdings[0].symbol = "9432.T";
    const saved = await fetch(`${base}/api/v1/state`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: importedState.revision, data: legacyPut })
    });
    assert.equal(saved.status, 200);
    const savedState = await saved.json();
    const savedHolding = savedState.data.holdings[0];
    assert.equal(savedHolding.symbol, "9432");
    assert.equal(savedHolding.price, 100);
    assert.equal(savedHolding.previousClose, 95);
    const duplicate = structuredClone(savedState.data);
    duplicate.holdings.push({ ...duplicate.holdings[0], id: "duplicate", symbol: "9432.t" });
    const rejected = await fetch(`${base}/api/v1/state`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: savedState.revision, data: duplicate })
    });
    assert.equal(rejected.status, 400);
    assert.equal((await (await fetch(`${base}/api/v1/state`)).json()).revision, savedState.revision);
    duplicate.holdings[1].accountCategoryCode = "nisa_growth";
    const separateCategory = await fetch(`${base}/api/v1/state`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: savedState.revision, data: duplicate })
    });
    assert.equal(separateCategory.status, 200);
    assert.equal((await separateCategory.json()).data.holdings[1].symbol, "9432");
    for (const symbol of ["9432", "9432.T", "9432.t"]) {
      const quote = await fetch(`${base}/api/quote?symbol=${symbol}&type=${encodeURIComponent("日本株")}`);
      assert.equal(quote.status, 200, JSON.stringify(await quote.json()));
    }
    const name = await fetch(`${base}/api/name?symbol=9432&type=${encodeURIComponent("日本株")}`);
    assert.equal(name.status, 200);
    assert.equal((await name.json()).name, "日本電信電話(株)");
    const oldClientName = await fetch(`${base}/api/name?symbol=9432.T`);
    assert.equal(oldClientName.status, 200);
  } finally {
    if (child.exitCode === null) {
      const stopped = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await stopped;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
