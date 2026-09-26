const AssetCompassSymbols = (() => {
  function normalizeStoredSymbol(type, symbol) {
    const value = String(symbol ?? "").trim();
    return type === "日本株" ? value.replace(/\.T$/i, "").toUpperCase() : value;
  }

  function toQuoteSymbol(type, symbol) {
    const value = normalizeStoredSymbol(type, symbol);
    return type === "日本株" && value ? `${value}.T` : value;
  }

  function displaySymbol(type, symbol) {
    return normalizeStoredSymbol(type, symbol);
  }

  function sameHoldingSlot(a, b) {
    return a.accountId === b.accountId && (a.accountCategoryCode || "unassigned") === (b.accountCategoryCode || "unassigned") &&
      a.type === b.type && normalizeStoredSymbol(a.type, a.symbol).toUpperCase() === normalizeStoredSymbol(b.type, b.symbol).toUpperCase();
  }

  return { normalizeStoredSymbol, toQuoteSymbol, displaySymbol, sameHoldingSlot };
})();

if (typeof module !== "undefined" && module.exports) module.exports = AssetCompassSymbols;
