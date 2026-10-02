const { getEntry } = require("./classification-masters");

const drillrSectors = new Map([
  ["energy", "ENERGY"], ["basic materials", "MATERIALS"], ["industrials", "INDUSTRIALS"],
  ["consumer cyclical", "CONSUMER_DISCRETIONARY"], ["consumer defensive", "CONSUMER_STAPLES"],
  ["healthcare", "HEALTH_CARE"], ["financial services", "FINANCIALS"],
  ["technology", "INFORMATION_TECHNOLOGY"], ["communication services", "COMMUNICATION_SERVICES"],
  ["utilities", "UTILITIES"], ["real estate", "REAL_ESTATE"]
]);

function normalizeDrillrSector(value) {
  if (typeof value !== "string") return null;
  return drillrSectors.get(value.trim().replace(/\s+/g, " ").toLowerCase()) ?? null;
}

function normalizeIndustryCode(value) {
  if (typeof value !== "string" || /^(?:unknown|n\/?a|not available|null)$/i.test(value.trim())) return null;
  const code = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return code && code.length <= 128 ? code : null;
}

// Yahoo JPの33業種に限った初期変換。共通の業種マスタや企業別補正ではない。
const japaneseIndustries = [
  ["水産・農林業", "FISHERY_AGRICULTURE_FORESTRY", "CONSUMER_STAPLES"],
  ["鉱業", "MINING", "MATERIALS"],
  ["建設業", "CONSTRUCTION", "INDUSTRIALS"],
  ["食料品", "FOODS", "CONSUMER_STAPLES"],
  ["繊維製品", "TEXTILES_APPAREL", "CONSUMER_DISCRETIONARY"],
  ["パルプ・紙", "PULP_PAPER", "MATERIALS"],
  ["化学", "CHEMICALS", "MATERIALS"],
  ["医薬品", "PHARMACEUTICALS", "HEALTH_CARE"],
  ["石油・石炭製品", "PETROLEUM_COAL_PRODUCTS", "ENERGY"],
  ["ゴム製品", "RUBBER_PRODUCTS", "CONSUMER_DISCRETIONARY"],
  ["ガラス・土石製品", "GLASS_CERAMICS", "MATERIALS"],
  ["鉄鋼", "IRON_STEEL", "MATERIALS"],
  ["非鉄金属", "NONFERROUS_METALS", "MATERIALS"],
  ["金属製品", "METAL_PRODUCTS", "MATERIALS"],
  ["機械", "MACHINERY", "INDUSTRIALS"],
  ["電気機器", "ELECTRIC_APPLIANCES", "INFORMATION_TECHNOLOGY"],
  ["輸送用機器", "TRANSPORTATION_EQUIPMENT", "CONSUMER_DISCRETIONARY"],
  ["精密機器", "PRECISION_INSTRUMENTS", "INFORMATION_TECHNOLOGY"],
  ["その他製品", "OTHER_PRODUCTS", "CONSUMER_DISCRETIONARY"],
  ["電気・ガス業", "ELECTRIC_POWER_GAS", "UTILITIES"],
  ["陸運業", "LAND_TRANSPORTATION", "INDUSTRIALS"],
  ["海運業", "MARINE_TRANSPORTATION", "INDUSTRIALS"],
  ["空運業", "AIR_TRANSPORTATION", "INDUSTRIALS"],
  ["倉庫・運輸関連業", "WAREHOUSING_HARBOR_TRANSPORTATION", "INDUSTRIALS"],
  ["情報・通信業", "INFORMATION_COMMUNICATIONS", "COMMUNICATION_SERVICES"],
  ["卸売業", "WHOLESALE_TRADE", "INDUSTRIALS"],
  ["小売業", "RETAIL_TRADE", "CONSUMER_DISCRETIONARY"],
  ["銀行業", "BANKS", "FINANCIALS"],
  ["証券・商品先物取引業", "SECURITIES_COMMODITY_FUTURES", "FINANCIALS"],
  ["保険業", "INSURANCE", "FINANCIALS"],
  ["その他金融業", "OTHER_FINANCING_BUSINESS", "FINANCIALS"],
  ["不動産業", "REAL_ESTATE", "REAL_ESTATE"],
  ["サービス業", "SERVICES", "INDUSTRIALS"]
];
const japaneseIndex = new Map(japaneseIndustries.map(([label, industryCode, sectorCode]) =>
  [label, Object.freeze({ industryCode, sectorCode })]));
japaneseIndex.set("情報・通信", japaneseIndex.get("情報・通信業"));

function normalizeJapaneseIndustry(value) {
  if (typeof value !== "string") return null;
  return japaneseIndex.get(value.trim()) ?? null;
}

const sectorSensitivities = new Map([
  ["MATERIALS", "CYCLICAL"], ["INDUSTRIALS", "CYCLICAL"], ["CONSUMER_DISCRETIONARY", "CYCLICAL"],
  ["CONSUMER_STAPLES", "DEFENSIVE"], ["HEALTH_CARE", "DEFENSIVE"], ["UTILITIES", "DEFENSIVE"],
  ["FINANCIALS", "NEUTRAL"], ["INFORMATION_TECHNOLOGY", "NEUTRAL"],
  ["COMMUNICATION_SERVICES", "NEUTRAL"], ["REAL_ESTATE", "NEUTRAL"], ["ENERGY", "NEUTRAL"]
]);
const industrySensitivities = new Map([["INFORMATION_TECHNOLOGY:SEMICONDUCTORS", "CYCLICAL"]]);

function classifySensitivity(sectorCode, industryCode) {
  if (!getEntry("sector", sectorCode)) return null;
  return industrySensitivities.get(`${sectorCode}:${industryCode}`) ?? sectorSensitivities.get(sectorCode) ?? null;
}

function htmlText(value) {
  return value.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&#(x[0-9a-f]+|\d+);/gi, (_, number) => {
      const code = number[0].toLowerCase() === "x" ? parseInt(number.slice(1), 16) : Number(number);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }).trim();
}

function parseYahooJapaneseIndustry(html) {
  if (typeof html !== "string") return null;
  const labels = [];
  const block = html.match(/<div\b[^>]*\bid\s*=\s*["']industry["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
  if (block) for (const match of block.matchAll(/<(a|span)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    if (/industryName/i.test(match[0]) || /href\s*=\s*["'][^"']*\/search\/qi/i.test(match[0])) labels.push(htmlText(match[2]));
  }
  for (const row of html.matchAll(/<th\b[^>]*>\s*業種分類\s*<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi)) labels.push(htmlText(row[1]));
  const nonempty = [...new Set(labels.filter(Boolean))];
  const recognized = nonempty.map(normalizeJapaneseIndustry);
  // Unknown or conflicting primary classification labels are not inferred from other page text.
  if (!recognized.length || recognized.some(value => !value)) return null;
  const codes = new Set(recognized.map(value => value.industryCode));
  return codes.size === 1 ? recognized[0] : null;
}

module.exports = { normalizeDrillrSector, normalizeIndustryCode, normalizeJapaneseIndustry, classifySensitivity, parseYahooJapaneseIndustry };
