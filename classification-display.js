(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./classification-masters"));
  else root.AssetCompassClassificationDisplay = factory(root.AssetCompassClassificationMasters);
})(globalThis, function (masters) {
  const axes = Object.freeze({
    sector: Object.freeze({ label: "セクター", field: "sector", color: "sector" }),
    fundCategory: Object.freeze({ label: "ファンドカテゴリ", field: "fund_category", color: "fund-category" }),
    sensitivity: Object.freeze({ label: "景気感応度", field: "sensitivity", color: "sensitivity" })
  });

  function hasValidClassification(holding, kind) {
    return masters.getEntry(kind, masters.getEffectiveCode(holding, kind)) !== null;
  }

  function resolveInstrumentKind(holding) {
    if (holding?.type === "投資信託") return null;
    if (holding?.instrument_kind === "STOCK" || holding?.instrument_kind === "ETF") return holding.instrument_kind;
    if (hasValidClassification(holding, "fundCategory")) return "ETF";
    if (hasValidClassification(holding, "sector")) return "STOCK";
    return ["日本株", "米国株"].includes(holding?.type) ? "STOCK" : null;
  }

  function resolveClassificationGroup(holding) {
    if (holding?.type === "投資信託") return "fund";
    return resolveInstrumentKind(holding) === "ETF" ? "fund" : "stock";
  }

  function getDisplayClassifications(holding) {
    const kinds = resolveClassificationGroup(holding) === "fund" ? ["fundCategory", "sensitivity"] : ["sector", "sensitivity"];
    return kinds.flatMap(kind => {
      const axis = axes[kind];
      const code = masters.getEffectiveCode(holding, kind);
      const value = masters.getLabel(kind, code);
      return value ? [{ kind, axis: axis.label, color: axis.color, code, value }] : [];
    });
  }

  return Object.freeze({ axes, resolveInstrumentKind, resolveClassificationGroup, getDisplayClassifications });
});
