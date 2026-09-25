// Yahoo's chartPreviousClose refers to the start of the requested range.
// Use adjacent trading-session bars, never a calendar-day subtraction or adjclose.
function stockQuoteFromChart(result) {
  const meta = result?.meta;
  if (!Number.isFinite(meta?.regularMarketPrice) || meta.regularMarketPrice < 0) throw new Error("Quote unavailable");
  const priceTimestamp = Number.isFinite(meta.regularMarketTime) && meta.regularMarketTime > 0 ? meta.regularMarketTime * 1000 : null;
  let previousClose = null;
  try {
    if (priceTimestamp && meta.exchangeTimezoneName && Array.isArray(result.timestamp)) {
      const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: meta.exchangeTimezoneName, year: "numeric", month: "2-digit", day: "2-digit" });
      const sessionDate = timestamp => formatter.format(new Date(timestamp));
      const currentDate = sessionDate(priceTimestamp);
      const closes = result.indicators?.quote?.[0]?.close || [];
      if (result.timestamp.some(timestamp => !Number.isFinite(timestamp) || timestamp <= 0)) throw new Error("Invalid session timestamp");
      const bars = result.timestamp.map((timestamp, index) => ({ timestamp, close: closes[index] }))
        .sort((a, b) => a.timestamp - b.timestamp);
      const currentIndex = bars.findIndex(bar => sessionDate(bar.timestamp * 1000) === currentDate);
      const previous = bars[currentIndex - 1];
      // If the immediately preceding bar is missing a close, do not skip to an older one.
      if (previous && sessionDate(previous.timestamp * 1000) !== currentDate && Number.isFinite(previous.close) && previous.close > 0) {
        // Yahoo daily bars have float32 noise; priceHint is Yahoo's quote precision.
        const precision = meta.priceHint;
        previousClose = Number.isInteger(precision) && precision >= 0 && precision <= 8
          ? Number(previous.close.toFixed(precision)) : previous.close;
        if (previousClose <= 0) previousClose = null;
      }
    }
  } catch { /* Missing/invalid session metadata must not prevent a price update. */ }
  return { price: meta.regularMarketPrice, previousClose, priceTimestamp };
}

function fundPreviousClose(priceBoardHtml, price) {
  // Only read the primary (yen) change from this quote's price board, not the %.
  const board = priceBoardHtml.split(/_CommonPriceBoard__mainFooter_|<\/section>/)[0];
  if (!board.includes("前日比")) return null;
  const primary = board.match(/_PriceChangeLabel__primary_[^>]*>([\s\S]*?)<\/span>\s*<\/span>/)?.[1];
  const text = primary?.replace(/<[^>]*>/g, "").replace(/&minus;|&#8722;|&#x2212;|−|－/gi, "-").replace(/＋/g, "+").trim();
  // An unsigned nonzero number could be an incorrectly parsed field. Explicit zero is valid.
  if (!text || !/^(?:[+-]\d[\d,]*(?:\.\d+)?|0(?:\.0+)?)$/.test(text)) return null;
  const change = Number(text.replaceAll(",", ""));
  const previousClose = price - change;
  return Number.isFinite(price) && Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null;
}

module.exports = { stockQuoteFromChart, fundPreviousClose };
