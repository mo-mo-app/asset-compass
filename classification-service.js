// Server-only service. It is deliberately not served to the browser or wired into price refresh.
const { normalizeStoredSymbol, toQuoteSymbol } = require("./symbols");
const { normalizeDrillrSector, normalizeIndustryCode, classifySensitivity, parseYahooJapaneseIndustry } = require("./classification-rules");

function warn(logger, message) {
  // Never log response bodies, headers, API keys, symbols or exception messages.
  try { logger?.warn?.(`[classification] ${message}`); } catch { /* Logging must not fail a classification request. */ }
}

function isStock(holding) {
  return ["米国株", "日本株"].includes(holding?.type) && !holding.auto_fund_category_code && !holding.user_fund_category_code;
}

function patchFor(sectorCode, industryCode, holding) {
  const patch = {};
  if (sectorCode) patch.auto_sector_code = sectorCode;
  if (industryCode) patch.auto_industry_code = industryCode;
  // If the new industry is missing, use the retained automatic industry for sensitivity.
  // Unknown new sectors do not trigger a new sensitivity guess, even if an old sector exists.
  if (sectorCode) {
    const sensitivity = classifySensitivity(sectorCode, industryCode ?? holding.auto_industry_code);
    if (sensitivity) patch.auto_sensitivity_code = sensitivity;
  }
  return patch;
}

async function classifyHolding(holding, {
  apiKey = process.env.DRILLR_API_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  logger = console
} = {}) {
  if (!isStock(holding)) return { status: "skipped", reason: "unsupported_asset", patch: {} };
  if (typeof holding.symbol !== "string") return { status: "skipped", reason: "invalid_symbol", patch: {} };
  const symbol = normalizeStoredSymbol(holding.type, holding.symbol).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,31}$/.test(symbol)) return { status: "skipped", reason: "invalid_symbol", patch: {} };
  const us = holding.type === "米国株";
  const source = us ? "DRILLR" : "YAHOO_JP_TSE33";
  if (us && (typeof apiKey !== "string" || !apiKey.trim())) {
    warn(logger, "DRILLR_API_KEY is not configured; US classification skipped.");
    return { status: "skipped", reason: "missing_api_key", source, patch: {} };
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Classification timeout must be a positive integer.");
  const url = us ? `https://gateway.drillr.ai/api/v2/company-profile?ticker=${encodeURIComponent(symbol)}`
    : `https://finance.yahoo.co.jp/quote/${encodeURIComponent(toQuoteSymbol(holding.type, symbol))}/profile`;
  const headers = us ? { "X-API-KEY": apiKey, "User-Agent": "AssetCompass/1.0" }
    : { "User-Agent": "Mozilla/5.0 (Asset Compass)" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Refuse redirects so credentials cannot be forwarded to a different origin.
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      warn(logger, "Classification provider returned an HTTP error; existing values retained.");
      return { status: "failed", reason: "http_error", httpStatus: response.status, source, patch: {} };
    }
    let sectorCode = null, industryCode = null;
    if (us) {
      const payload = await response.json();
      // The documented v2 response is {data: [{ticker, market, sector, industry, ...}]}.
      const profiles = Array.isArray(payload?.data) ? payload.data.filter(profile =>
        typeof profile?.ticker === "string" && profile.ticker.toUpperCase() === symbol && profile.market === "US") : [];
      if (profiles.length !== 1) throw new Error("Invalid company profile response.");
      const profile = profiles[0];
      if (profile.isEtf === true || profile.isFund === true) return { status: "skipped", reason: "unsupported_asset", source, patch: {} };
      sectorCode = normalizeDrillrSector(profile.sector);
      industryCode = normalizeIndustryCode(profile.industry);
    } else {
      const classification = parseYahooJapaneseIndustry(await response.text());
      if (classification) ({ sectorCode, industryCode } = classification);
    }
    if (controller.signal.aborted) throw new Error("Classification timed out.");
    const patch = patchFor(sectorCode, industryCode, holding);
    if (!Object.keys(patch).length) {
      warn(logger, "No recognized classification was found; existing values retained.");
      return { status: "unclassified", reason: "no_valid_classification", source, patch };
    }
    return { status: "classified", source, patch };
  } catch {
    const reason = controller.signal.aborted ? "timeout" : "request_or_parse_error";
    warn(logger, "Classification request failed or could not be parsed; existing values retained.");
    return { status: "failed", reason, source, patch: {} };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshClassification(holdingId, { force = false, repository, ...options } = {}) {
  // Lazy database import avoids opening/migrating a database just by importing this module.
  const storage = repository ?? require("./database");
  const state = storage.getState();
  if (!state.initialized) return { status: "skipped", reason: "state_not_initialized" };
  const holding = state.data.holdings.find(item => item.id === holdingId);
  if (!holding) return { status: "skipped", reason: "holding_not_found" };
  if (!isStock(holding)) return { status: "skipped", reason: "unsupported_asset" };
  if (force !== true && [holding.auto_sector_code, holding.auto_industry_code, holding.auto_sensitivity_code].every(Boolean)) {
    return { status: "skipped", reason: "already_classified" };
  }
  const result = await classifyHolding(holding, options);
  if (result.status !== "classified") return result;
  // Revision checking protects concurrent user/price edits and prevents stale identity updates.
  // Normal refresh fills missing auto codes only. Explicit force retains reclassification behavior.
  const patch = force === true ? result.patch : Object.fromEntries(
    Object.entries(result.patch).filter(([field]) => !holding[field])
  );
  const saved = storage.saveAutomaticClassification(holdingId, state.revision, patch);
  return { ...saved, source: result.source };
}

module.exports = { classifyHolding, refreshClassification };
