const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { classifyHolding, refreshClassification } = require("../classification-service");
const options = { apiKey: "fixture-only-not-a-real-credential", logger: null };
const stock = { id: "h", type: "米国株", symbol: "NVDA", user_sector_code: "FINANCIALS" };
const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures/classification", name), "utf8");
const profileResponse = ticker => new Response(fixture(`drillr-${ticker}.json`), { status: 200 });

for (const symbol of ["NVDA", "MU"]) test(`drillr ${symbol} fixture normalizes sector/industry and sends the key only in its header`, async () => {
  const holding = { ...stock, symbol };
  const before = structuredClone(holding);
  const result = await classifyHolding(holding, { ...options, fetchImpl: async (url, request) => {
    assert.equal(url, `https://gateway.drillr.ai/api/v2/company-profile?ticker=${symbol}`);
    assert.equal(request.headers["X-API-KEY"], options.apiKey);
    assert.equal(request.redirect, "error");
    assert.ok(request.signal instanceof AbortSignal);
    return profileResponse(symbol);
  } });
  assert.deepEqual(result, { status: "classified", source: "DRILLR", patch: {
    auto_sector_code: "INFORMATION_TECHNOLOGY", auto_industry_code: "SEMICONDUCTORS", auto_sensitivity_code: "CYCLICAL"
  } });
  assert.deepEqual(holding, before);
  assert.ok(!JSON.stringify(result).includes(options.apiKey));
});
for (const status of [401, 429, 500]) test(`drillr HTTP ${status} returns no updates and never logs provider bodies`, async () => {
  const logs = [];
  const result = await classifyHolding(stock, { ...options, logger: { warn: value => logs.push(value) },
    fetchImpl: async () => new Response(options.apiKey, { status }) });
  assert.equal(result.status, "failed");
  assert.equal(result.httpStatus, status);
  assert.deepEqual(result.patch, {});
  assert.ok(!JSON.stringify([result, logs]).includes(options.apiKey));
});
test("missing drillr key skips requests with a sanitized warning", async () => {
  const logs = [];
  const result = await classifyHolding(stock, { ...options, apiKey: null, logger: { warn: message => logs.push(message) },
    fetchImpl: async () => assert.fail("must not request without a key") });
  assert.equal(result.reason, "missing_api_key");
  assert.equal(logs.length, 1);
  assert.deepEqual(result.patch, {});
});
test("malformed, mismatched and duplicate company responses are rejected", async () => {
  const bodies = ["not JSON", JSON.stringify({ data: [] }), JSON.stringify({ data: [{ ticker: "MU", market: "US", sector: "Technology" }] }),
    JSON.stringify({ data: [{ ticker: "NVDA", market: "JP", sector: "Technology" }] }),
    JSON.stringify({ data: [{ ticker: "NVDA", market: "US" }, { ticker: "NVDA", market: "US" }] })];
  for (const body of bodies) {
    const result = await classifyHolding(stock, { ...options, fetchImpl: async () => new Response(body) });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.patch, {});
  }
});
test("unknown fields preserve old values, and sensitivity does not guess from an unknown sector", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ ticker: "NVDA", market: "US", sector: "Future Sector", industry: "Software - Infrastructure" }] }));
  const result = await classifyHolding({ ...stock, auto_sector_code: "INFORMATION_TECHNOLOGY", auto_sensitivity_code: "CYCLICAL" }, { ...options, fetchImpl });
  assert.deepEqual(result.patch, { auto_industry_code: "SOFTWARE_INFRASTRUCTURE" });
  const partial = await classifyHolding({ ...stock, auto_industry_code: "SEMICONDUCTORS" }, { ...options,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ ticker: "NVDA", market: "US", sector: "Technology", industry: null }] })) });
  assert.deepEqual(partial.patch, { auto_sector_code: "INFORMATION_TECHNOLOGY", auto_sensitivity_code: "CYCLICAL" });
  const empty = await classifyHolding(stock, { ...options,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ ticker: "NVDA", market: "US", sector: null, industry: null }] })) });
  assert.equal(empty.status, "unclassified");
  assert.deepEqual(empty.patch, {});
});
for (const [symbol, industry, sector] of [["8766.T", "INSURANCE", "FINANCIALS"], ["9432", "INFORMATION_COMMUNICATIONS", "COMMUNICATION_SERVICES"]]) {
  test(`Yahoo JP ${symbol} fixture uses the canonical .T profile URL without drillr credentials`, async () => {
    const result = await classifyHolding({ type: "日本株", symbol }, { ...options, fetchImpl: async (url, request) => {
      assert.equal(url, `https://finance.yahoo.co.jp/quote/${symbol.replace(/\.T$/, "")}.T/profile`);
      assert.equal(request.headers["X-API-KEY"], undefined);
      return new Response(fixture(`yahoo-${symbol.slice(0, 4)}.html`));
    } });
    assert.deepEqual(result, { status: "classified", source: "YAHOO_JP_TSE33", patch: {
      auto_sector_code: sector, auto_industry_code: industry, auto_sensitivity_code: "NEUTRAL"
    } });
  });
}
test("Yahoo errors and changed markup return no patch", async () => {
  for (const fetchImpl of [async () => new Response("provider failure", { status: 500 }),
    async () => new Response("<p>業種: 保険業</p>"), async () => { throw new Error(options.apiKey); }]) {
    const logs = [];
    const result = await classifyHolding({ type: "日本株", symbol: "8766", auto_industry_code: "INSURANCE" },
      { ...options, logger: { warn: message => logs.push(message) }, fetchImpl });
    assert.deepEqual(result.patch, {});
    assert.ok(!JSON.stringify([result, logs]).includes(options.apiKey));
  }
});
test("network and body timeouts retain classification, and logging failures do not propagate", async () => {
  for (const duringBody of [false, true]) {
    const fetchImpl = async (_, { signal }) => {
      const abort = () => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error(options.apiKey)), { once: true }));
      return duringBody ? { ok: true, json: abort } : abort();
    };
    const result = await classifyHolding(stock, { ...options, timeoutMs: 15, logger: { warn() { throw new Error("logger failure"); } }, fetchImpl });
    assert.equal(result.reason, "timeout");
    assert.deepEqual(result.patch, {});
  }
});
test("funds, known ETFs and invalid symbols never trigger external requests", async () => {
  for (const holding of [{ type: "投資信託", symbol: "03311187" }, { ...stock, auto_fund_category_code: "BROAD_INDEX" },
    { ...stock, user_fund_category_code: "OTHER" }, { ...stock, symbol: "AAPL?apiKey=bad" }, { ...stock, symbol: null }]) {
    const result = await classifyHolding(holding, { ...options, fetchImpl: async () => assert.fail("must not fetch") });
    assert.equal(result.status, "skipped");
  }
  const result = await classifyHolding(stock, { ...options, fetchImpl: async () => new Response(JSON.stringify({ data: [{ ticker: "NVDA", market: "US", isEtf: true }] })) });
  assert.equal(result.status, "skipped");
});
test("refresh only requests incomplete or explicitly forced classification, and defaults are independent of user overrides", async () => {
  const holding = { ...stock, auto_sector_code: "INFORMATION_TECHNOLOGY", auto_industry_code: "SEMICONDUCTORS", auto_sensitivity_code: "CYCLICAL" };
  let requests = 0;
  const repository = { getState: () => ({ initialized: true, revision: 7, data: { holdings: [holding] } }),
    saveAutomaticClassification: (id, revision, patch) => {
      assert.equal(id, "h"); assert.equal(revision, 7); assert.equal(patch.auto_sector_code, "INFORMATION_TECHNOLOGY");
      return { status: "updated", revision: 8 };
    } };
  const args = { ...options, repository, fetchImpl: async () => { requests++; return profileResponse("NVDA"); } };
  assert.equal((await refreshClassification("h", args)).reason, "already_classified");
  assert.equal(requests, 0);
  assert.equal((await refreshClassification("h", { ...args, force: true })).status, "updated");
  assert.equal(requests, 1);
  holding.auto_sector_code = null;
  assert.equal((await refreshClassification("h", args)).status, "updated");
  assert.equal(requests, 2);
});
test("refresh skips missing holdings and uninitialized state without requesting providers", async () => {
  for (const state of [{ initialized: false }, { initialized: true, data: { holdings: [] } }]) {
    const result = await refreshClassification("missing", { ...options, repository: { getState: () => state }, fetchImpl: async () => assert.fail("must not fetch") });
    assert.equal(result.status, "skipped");
  }
});

test("normal refresh fills each missing-auto combination and never rewrites retained auto or user codes", async () => {
  const fields = ['auto_sector_code', 'auto_industry_code', 'auto_sensitivity_code'];
  for (let mask = 1; mask < 8; mask++) {
    const holding = { ...stock, user_industry_code: 'CUSTOM', user_sensitivity_code: 'DEFENSIVE' };
    const missing = fields.filter((field, index) => {
      const missing = Boolean(mask & (1 << index));
      holding[field] = missing ? null : ['FINANCIALS', 'INSURANCE', 'DEFENSIVE'][index];
      return missing;
    });
    const before = structuredClone(holding);
    const repository = { getState: () => ({ initialized: true, revision: 1, data: { holdings: [holding] } }),
      saveAutomaticClassification: (id, revision, patch) => {
        assert.equal(id, 'h'); assert.equal(revision, 1);
        assert.deepEqual(Object.keys(patch), missing);
        assert.ok(Object.values(patch).every(Boolean));
        return { status: 'updated', revision: 2 };
      } };
    assert.equal((await refreshClassification('h', { ...options, repository, fetchImpl: async () => profileResponse('NVDA') })).status, 'updated');
    assert.deepEqual(holding, before);
  }
});
