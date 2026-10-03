const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
const jpMissing = () => new Response("<title>Yahoo!ファイナンス</title>", { status: 404 });
const search = quotes => new Response(JSON.stringify({ quotes }), { headers: { "Content-Type": "application/json" } });
const soxl = { symbol: "SOXL", quoteType: "ETF", shortname: "Direxion Daily Semiconductor Bu", longname: "Direxion Daily Semiconductor Bull 3X Shares" };

// Capture the real HTTP handler without opening a listener or importing the database.
function nameApi(jpResponse, searchResponse) {
  const requests = [];
  let handler;
  vm.runInNewContext(source, {
    __dirname: root, URL, Buffer, console: { log() {}, error() {} }, process: { env: { ASSET_COMPASS_BIND_LAN: "false" } },
    require(name) {
      if (name === "http") return { createServer(callback) { handler = callback; return { on() {}, listen() {} }; } };
      if (name === "os") return { networkInterfaces: () => ({}) };
      if (name === "./database") return new Proxy({}, { get() { return () => assert.fail("Name lookup must not access the DB"); } });
      return require(name.startsWith("./") ? path.join(root, name) : name);
    },
    fetch: async (address, options) => {
      const url = new URL(address);
      requests.push(url);
      assert.equal(typeof options.headers["User-Agent"], "string");
      if (url.hostname === "finance.yahoo.co.jp") return jpResponse(url);
      assert.equal(url.hostname, "query1.finance.yahoo.com");
      assert.equal(url.pathname, "/v1/finance/search");
      assert.equal(url.searchParams.get("quotesCount"), "10");
      assert.equal(url.searchParams.get("newsCount"), "0");
      return searchResponse(url);
    }
  });
  return { requests, async request(symbol, type = "米国株") {
    let status, body;
    const query = new URLSearchParams({ symbol });
    if (type !== null) query.set("type", type);
    await handler({ method: "GET", url: `/api/name?${query}` }, {
      writeHead(code) { status = code; }, end(payload) { body = JSON.parse(payload); }
    });
    return { status, body };
  } };
}

test("SOXL falls back after Yahoo Japan 404 and returns the name plus ETF kind", async () => {
  const api = nameApi(jpMissing, url => { assert.equal(url.searchParams.get("q"), "SOXL"); return search([soxl]); });
  assert.deepEqual(await api.request("SOXL"), { status: 200, body: { name: soxl.longname, instrument_kind: "ETF" } });
  assert.deepEqual(api.requests.map(url => url.hostname), ["finance.yahoo.co.jp", "query1.finance.yahoo.com"]);
  assert.equal(api.requests[0].pathname, "/quote/SOXL");
});

test("NVDA keeps its Japanese name and uses the exact Yahoo quote type", async () => {
  const api = nameApi(() => new Response("<title>エヌビディア【NVDA】：株価・株式情報 - Yahoo!ファイナンス</title>"),
    () => search([{ symbol: "NVDA", quoteType: "EQUITY", longname: "NVIDIA Corporation" }]));
  assert.deepEqual(await api.request("NVDA"), { status: 200, body: { name: "エヌビディア", instrument_kind: "STOCK" } });
  assert.equal(api.requests.length, 2);
});

test("name lookup remains successful and leaves instrument kind unset when type enrichment fails", async () => {
  const api = nameApi(() => new Response("<title>エヌビディア【NVDA】：株価・株式情報 - Yahoo!ファイナンス</title>"),
    () => { throw new Error("metadata unavailable"); });
  assert.deepEqual(await api.request("NVDA"), { status: 200, body: { name: "エヌビディア" } });
});

test("Japanese stock tickers use an exact Yahoo quote type when available", async () => {
  const api = nameApi(() => new Response("<title>トヨタ自動車【7203】：株価・株式情報 - Yahoo!ファイナンス</title>"),
    url => { assert.equal(url.searchParams.get("q"), "7203.T"); return search([{ symbol: "7203.T", quoteType: "EQUITY", longname: "Toyota" }]); });
  assert.deepEqual(await api.request("7203", "日本株"), { status: 200, body: { name: "トヨタ自動車", instrument_kind: "STOCK" } });
});

test("similar tickers, other markets, crypto and options cannot substitute for an exact SOXL match", async () => {
  const lookalikes = ["SOXL.NE", "SOXL.L", "SOXL.MX", "SOXL.MI", "SOXL-USD", "SOXL261016P00140000"]
    .map(symbol => ({ ...soxl, symbol, longname: "must not use" }));
  const withExact = nameApi(jpMissing, () => search([...lookalikes, soxl]));
  assert.equal((await withExact.request("SOXL")).body.name, soxl.longname);
  const withoutExact = nameApi(jpMissing, () => search(lookalikes));
  assert.deepEqual(await withoutExact.request("SOXL"), { status: 502, body: { error: "Yahoo!ファイナンスで銘柄コードが見つかりません" } });
});

test("exact matching accepts only EQUITY and ETF quote types", async () => {
  for (const quoteType of ["OPTION", "CRYPTOCURRENCY", "INDEX", "MUTUALFUND", "FUTURE", "CURRENCY", "etf", null, undefined]) {
    const api = nameApi(jpMissing, () => search([{ ...soxl, quoteType }]));
    assert.equal((await api.request("SOXL")).status, 502, `Must reject ${quoteType}`);
  }
  const api = nameApi(jpMissing, () => search([{ symbol: "NVDA", quoteType: "EQUITY", longname: "NVIDIA Corporation" }]));
  assert.deepEqual(await api.request("NVDA"), { status: 200, body: { name: "NVIDIA Corporation", instrument_kind: "STOCK" } });
});

test("longname wins over shortname, and missing or blank longname uses shortname", async () => {
  for (const longname of [undefined, null, "", "   ", 42]) {
    const api = nameApi(jpMissing, () => search([{ ...soxl, longname, shortname: " SOXL short name " }]));
    assert.equal((await api.request("SOXL")).body.name, "SOXL short name");
  }
  const api = nameApi(jpMissing, () => search([{ ...soxl, longname: " Full name " }]));
  assert.equal((await api.request("SOXL")).body.name, "Full name");
});

test("HTTP, network, JSON and unusable search results retain the existing 502 response and original error", async () => {
  const failures = [
    () => new Response("rate limited", { status: 429 }),
    () => { throw new Error("search failed"); },
    () => new Response("not JSON"),
    () => search([]),
    () => new Response(JSON.stringify({ quotes: {} })),
    () => search([null, {}, { ...soxl, longname: null, shortname: null }])
  ];
  for (const failed of failures) {
    const api = nameApi(jpMissing, failed);
    assert.deepEqual(await api.request("SOXL"), { status: 502, body: { error: "Yahoo!ファイナンスで銘柄コードが見つかりません" } });
  }
  const api = nameApi(() => { throw new Error("original request failed"); }, failures[0]);
  assert.deepEqual(await api.request("SOXL"), { status: 502, body: { error: "original request failed" } });
});

test("Yahoo Japan network errors, missing titles and empty names also trigger the US fallback", async () => {
  for (const failed of [() => { throw new Error("network error"); }, () => new Response("<html></html>"), () => new Response("<title> </title>")]) {
    const api = nameApi(failed, () => search([soxl]));
    assert.equal((await api.request("SOXL")).body.name, soxl.longname);
    assert.equal(api.requests.length, 2);
  }
  const api = nameApi(() => new Response("<html></html>"), () => search([]));
  assert.deepEqual(await api.request("SOXL"), { status: 502, body: { error: "Yahoo!ファイナンスから銘柄名を取得できませんでした" } });
});

test("legacy US clients and lowercase input use exact canonical matching; Japanese and fund requests retain their original failure", async () => {
  for (const [symbol, type] of [["SOXL", null], ["soxl", "米国株"]]) {
    const api = nameApi(jpMissing, () => search([soxl]));
    assert.equal((await api.request(symbol, type)).body.name, soxl.longname);
  }
  for (const [symbol, type] of [["9432", "日本株"], ["9432.T", null], ["03311187", "投資信託"]]) {
    const api = nameApi(jpMissing, () => assert.fail("Non-US behavior must stay unchanged"));
    assert.equal((await api.request(symbol, type)).status, 502);
    assert.equal(api.requests.length, 1);
  }
  const api = nameApi(jpMissing, () => search([soxl]));
  assert.deepEqual(await api.request("SOXL/invalid"), { status: 502, body: { error: "Invalid symbol" } });
  assert.equal(api.requests.length, 0);
});
