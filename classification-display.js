(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./classification-masters"));
  else root.AssetCompassClassificationDisplay = factory(root.AssetCompassClassificationMasters);
})(globalThis, function (masters) {
  const axes = Object.freeze({
    sector: Object.freeze({ label: "セクター", field: "sector", color: "sector" }),
    fundCategory: Object.freeze({ label: "ファンドカテゴリ", field: "fund_category", color: "fund-category" }),
    sensitivity: Object.freeze({ label: "景気感応度", field: "sensitivity", color: "sensitivity" })
  });

  function getDisplayClassifications(holding) {
    const isFund = holding?.type === "投資信託" ||
      holding?.user_fund_category_code != null || holding?.auto_fund_category_code != null;
    const kinds = isFund ? ["fundCategory", "sensitivity"] : ["sector", "sensitivity"];
    return kinds.flatMap(kind => {
      const axis = axes[kind];
      const code = masters.getEffectiveCode(holding, kind);
      const value = masters.getLabel(kind, code);
      return value ? [{ kind, axis: axis.label, color: axis.color, code, value }] : [];
    });
  }

  return Object.freeze({ axes, getDisplayClassifications });
});
