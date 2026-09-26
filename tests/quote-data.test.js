const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stockQuoteFromChart, fundPreviousClose } = require("../quote-data");

const seconds = date => Date.parse(date) / 1000;
function chart(dates, closes, time = dates.at(-1), zone = "Asia/Tokyo") {
  return {
    meta: { regularMarketPrice: 100, regularMarketTime: seconds(time), exchangeTimezoneName: zone, chartPreviousClose: 42, previousClose: 41, priceHint: 2 },
    timestamp: dates.map(seconds), indicators: { quote: [{ close: closes }] }
  };
}

test("stocks use the preceding trading session across weekends/holidays, not range-start close", () => {
  const result = chart(["2026-09-18T00:00:00Z", "2026-09-24T00:00:00Z", "2026-09-25T00:00:00Z"], [80, 95, 100], "2026-09-25T06:30:00Z");
  assert.equal(stockQuoteFromChart(result).previousClose, 95);
  result.meta.regularMarketTime = seconds("2026-09-24T06:30:00Z");
  assert.equal(stockQuoteFromChart(result).previousClose, 80, "ignore bars after the quote session");
});

test("US session dates use exchange timezone, including DST and quotes after UTC midnight", () => {
  const result = chart(["2026-03-06T14:30:00Z", "2026-03-09T13:30:00Z"], [98, 100], "2026-03-09T20:00:00Z", "America/New_York");
  assert.equal(stockQuoteFromChart(result).previousClose, 98);
  const overnight = chart(["2026-09-24T13:30:00Z", "2026-09-25T13:30:00Z"], [97, 100], "2026-09-26T00:30:00Z", "America/New_York");
  assert.equal(stockQuoteFromChart(overnight).previousClose, 97);
});

test("missing immediately previous close/session metadata yields null without losing price", () => {
  const result = chart(["2026-09-23T00:00:00Z", "2026-09-24T00:00:00Z", "2026-09-25T00:00:00Z"], [90, null, 100]);
  assert.equal(stockQuoteFromChart(result).previousClose, null);
  for (const close of [undefined, NaN, 0, -10]) {
    result.indicators.quote[0].close[1] = close;
    assert.equal(stockQuoteFromChart(result).previousClose, null);
  }
  result.indicators.quote[0].close[1] = 100.000001;
  assert.equal(stockQuoteFromChart(result).previousClose, 100, "remove float32 noise for actual 0%");
  result.meta.exchangeTimezoneName = "invalid";
  assert.equal(stockQuoteFromChart(result).previousClose, null);
  assert.equal(stockQuoteFromChart(result).price, 100);
  assert.equal(stockQuoteFromChart(chart(["2026-09-25T00:00:00Z"], [100])).previousClose, null);
  assert.equal(stockQuoteFromChart(chart(["2026-09-24T00:00:00Z"], [90], "2026-09-25T06:00:00Z")).previousClose, null);
});

function fundBoard(change) {
  return `<div>前日比<dd><span class="_PriceChangeLabel__primary_hash"><span class="_StyledNumber__value_hash">${change}</span></span><span class="_PriceChangeLabel__secondary_hash"><span>+0.52</span>%</span></dd></div><div class="_CommonPriceBoard__mainFooter_hash"><time>9/25</time></div>`;
}
test("fund previous NAV uses signed yen change, never rounded percentage", () => {
  assert.equal(fundPreviousClose(fundBoard("+148"), 28871), 28723);
  assert.equal(fundPreviousClose(fundBoard("−1,200"), 28871), 30071);
  assert.equal(fundPreviousClose(fundBoard("&minus;148"), 28871), 29019);
  for (const zero of ["0", "+0", "-0"]) assert.equal(fundPreviousClose(fundBoard(zero), 28871), 28871);
  for (const missing of ["---", "", "+0.52%", "148"]) assert.equal(fundPreviousClose(fundBoard(missing), 28871), null);
  assert.equal(fundPreviousClose("<div class='_CommonPriceBoard__mainFooter_hash'></div>" + fundBoard("+148"), 28871), null);
});

function appContext(fetch) {
  const context = vm.createContext({
    Intl, console, fetch, localStorage: { getItem: () => '{"accounts":[],"holdings":[]}' }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "symbols.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  // Load declarations only; no boot, UI events or production API calls.
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener("click"')), context);
  return context;
}
test("daily rate is local currency, distinguishes null/zero and excludes failed/unverified quotes", () => {
  const { dailyChangePercent } = appContext();
  const h = { price: 110, previousClose: 100, currency: "USD", quoteStatus: "success" };
  assert.equal(dailyChangePercent(h), 10);
  assert.equal(dailyChangePercent({ ...h, price: 100 }), 0);
  assert.equal(dailyChangePercent({ ...h, price: 90 }), -10);
  for (const previousClose of [null, undefined, 0, NaN]) assert.equal(dailyChangePercent({ ...h, previousClose }), null);
  for (const quoteStatus of [undefined, "unknown", "failed"]) assert.equal(dailyChangePercent({ ...h, quoteStatus }), null);
});

test("quote failures retain previous prices/dates, success clears missing comparison/date data", async () => {
  const h = { symbol: "AAPL", type: "米国株", price: 100, previousClose: 99, priceTimestamp: 1234, priceDate: "9/24" };
  const failed = appContext(async () => { throw new Error("offline"); });
  await assert.rejects(failed.updateQuote(h), /offline/);
  assert.equal(h.price, 100);
  assert.equal(h.previousClose, 99);
  assert.equal(h.priceTimestamp, 1234);
  assert.equal(h.quoteStatus, "failed");
  assert.ok(h.quoteAttemptedAt > 0);
  assert.equal(failed.dailyChangePercent(h), null);
  const success = appContext(async () => ({ ok: true, json: async () => ({ price: 101, previousClose: null }) }));
  await success.updateQuote(h);
  assert.equal(h.price, 101);
  assert.equal(h.previousClose, null);
  assert.equal(h.priceTimestamp, null);
  assert.equal(h.priceDate, null);
  assert.equal(h.quoteStatus, "success");
  assert.equal(success.dailyChangePercent(h), null);
});
