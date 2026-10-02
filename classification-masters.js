(function (root, factory) {
  const masters = factory();
  if (typeof module === "object" && module.exports) module.exports = masters;
  else root.AssetCompassClassificationMasters = masters;
})(globalThis, function () {
  function master(entries) {
    return Object.freeze(entries.map(entry => Object.freeze({
      ...entry, examples: Object.freeze(entry.examples)
    })));
  }

  // GICS 11 sectors相当の内部コード。公式GICSコードや外部APIの分類値ではない。
  const sectors = master([
    { code: "ENERGY", label: "エネルギー", description: "石油・ガスなどのエネルギー資源の開発、生産、供給に関わる分野。", examples: ["石油・ガス開発", "石油精製", "エネルギー設備・サービス"] },
    { code: "MATERIALS", label: "素材", description: "製造や建設などに使う原材料の生産・加工に関わる分野。", examples: ["化学", "金属・鉱業", "紙・包装材料"] },
    { code: "INDUSTRIALS", label: "資本財・サービス", description: "産業用設備、輸送、建設や事業者向けサービスに関わる分野。", examples: ["産業機械", "航空宇宙・防衛", "物流・輸送"] },
    { code: "CONSUMER_DISCRETIONARY", label: "一般消費財・サービス", description: "消費者が所得や景気に応じて支出を調整しやすい商品・サービスの分野。", examples: ["自動車", "耐久消費財", "旅行・レジャー"] },
    { code: "CONSUMER_STAPLES", label: "生活必需品", description: "日常生活で継続的に消費される商品やその販売に関わる分野。", examples: ["食品・飲料", "家庭用品", "生活必需品の小売"] },
    { code: "HEALTH_CARE", label: "ヘルスケア", description: "医薬品、医療機器、医療サービスなど健康・医療に関わる分野。", examples: ["医薬品", "医療機器", "医療サービス"] },
    { code: "FINANCIALS", label: "金融", description: "資金の仲介、保険、投資や金融サービスに関わる分野。", examples: ["銀行", "保険", "証券・資産運用"] },
    { code: "INFORMATION_TECHNOLOGY", label: "情報技術", description: "ソフトウェア、情報機器、半導体やITサービスに関わる分野。", examples: ["半導体", "ソフトウェア", "ITサービス"] },
    { code: "COMMUNICATION_SERVICES", label: "コミュニケーション・サービス", description: "通信、メディア、娯楽やインターネット上の交流に関わる分野。", examples: ["電気通信", "メディア・娯楽", "インターネットサービス"] },
    { code: "UTILITIES", label: "公益事業", description: "電気、ガス、水道などの公共インフラの供給に関わる分野。", examples: ["電力", "ガス供給", "水道"] },
    { code: "REAL_ESTATE", label: "不動産", description: "不動産の保有、運用、開発や関連サービスに関わる分野。", examples: ["不動産運用", "不動産開発", "不動産サービス"] }
  ]);

  // Examplesは説明用であり、業種や商品から感応度を割り当てるルールではない。
  const sensitivities = master([
    { code: "CYCLICAL", label: "景気敏感", description: "景気、設備投資、商品市況等の影響を受けやすい。", examples: ["設備投資需要に左右される事業", "商品市況に左右される事業"] },
    { code: "DEFENSIVE", label: "ディフェンシブ", description: "景気変動の影響が比較的小さい。", examples: ["生活必需品への継続的な需要", "医療などの継続的な需要"] },
    { code: "NEUTRAL", label: "中立", description: "景気敏感・ディフェンシブのどちらにも強く寄せにくい。", examples: ["異なる感応度を持つ事業の組み合わせ", "広範囲に分散された投資対象"] }
  ]);

  const fundCategories = master([
    { code: "BROAD_INDEX", label: "広範囲株式指数", description: "市場や地域を広くカバーする株式指数を主な投資対象とするカテゴリ。", examples: ["全世界株式指数型", "米国大型株指数型", "日本の広範囲株式指数型"] },
    { code: "NASDAQ_TECH", label: "NASDAQ・ハイテク", description: "NASDAQ系指数やハイテク株を主な投資対象とするカテゴリ。", examples: ["NASDAQ100連動型", "ハイテク株ファンド"] },
    { code: "SEMICONDUCTOR", label: "半導体", description: "半導体関連企業を主な投資対象とするカテゴリ。", examples: ["半導体株指数連動型", "半導体関連企業ファンド"] },
    { code: "AI_THEME", label: "AI・テクノロジーテーマ", description: "AIなど特定の技術テーマに沿って投資するカテゴリ。", examples: ["AI関連企業ファンド", "ロボティクス関連ファンド"] },
    { code: "HIGH_DIVIDEND", label: "高配当", description: "配当利回りや配当の継続性などに着目して投資するカテゴリ。", examples: ["高配当株指数連動型", "配当重視の株式ファンド"] },
    { code: "COVERED_CALL", label: "カバードコール", description: "保有資産とコールオプションの売却を組み合わせる戦略のカテゴリ。", examples: ["株式指数のカバードコールETF", "オプション収益を組み合わせるファンド"] },
    { code: "REIT", label: "REIT・不動産", description: "REITや不動産関連資産を主な投資対象とするカテゴリ。", examples: ["国内REIT指数連動型", "海外REITファンド"] },
    { code: "BOND", label: "債券", description: "国債、社債などの債券を主な投資対象とするカテゴリ。", examples: ["国債ファンド", "投資適格社債ETF"] },
    { code: "COMMODITY", label: "コモディティ", description: "金などの商品や商品指数を主な投資対象とするカテゴリ。", examples: ["金連動型", "総合商品指数連動型"] },
    { code: "BALANCED", label: "バランス", description: "株式、債券など複数の資産クラスを組み合わせるカテゴリ。", examples: ["株式・債券の複合ファンド", "複数資産に分散するファンド"] },
    { code: "OTHER", label: "その他", description: "他のファンドカテゴリに該当しない商品を明示的に分類するカテゴリ。", examples: ["他のカテゴリに含まれない投資戦略"] }
  ]);

  const indexes = new Map([
    ["sector", new Map(sectors.map(entry => [entry.code, entry]))],
    ["sensitivity", new Map(sensitivities.map(entry => [entry.code, entry]))],
    ["fundCategory", new Map(fundCategories.map(entry => [entry.code, entry]))]
  ]);
  const codeFields = new Map([
    ["sector", "sector"], ["industry", "industry"],
    ["sensitivity", "sensitivity"], ["fundCategory", "fund_category"]
  ]);

  function getEntry(kind, code) {
    return indexes.get(kind)?.get(code) ?? null;
  }
  function getLabel(kind, code) {
    return getEntry(kind, code)?.label ?? null;
  }
  function getEffectiveCode(holding, kind) {
    const field = codeFields.get(kind);
    if (!field) return null;
    return holding?.[`user_${field}_code`] ?? holding?.[`auto_${field}_code`] ?? null;
  }

  // Industryは共通マスタを持たない。将来はindustry_sourceごとのマスタで解決する。
  return Object.freeze({ sectors, sensitivities, fundCategories, getEntry, getLabel, getEffectiveCode });
});
