const KEY = "asset-compass-v1";
const LOCAL_BACKUP_KEY = "asset-compass-v1-pre-sync-backup";
const { normalizeStoredSymbol, displaySymbol, sameHoldingSlot } = AssetCompassSymbols;
const jpyNumber = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const goalInputNumber = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 20 });
const formatJpyAmount = amount => Number.isFinite(amount) ? `${jpyNumber.format(amount)}円` : "—";
const formatMetricJpyAmount = (amount, withSign = false) => {
  if (!Number.isFinite(amount)) return "—";
  const sign = withSign ? amount > 0 ? "+" : amount < 0 ? "-" : "" : "";
  return `${sign}<span class="metric-amount">${jpyNumber.format(Math.abs(amount))}</span><span class="metric-unit">円</span>`;
};
const number = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 });
function generateId() {
  const cryptoApi = window.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function readLocalData() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); }
  catch { return null; }
}
let data = readLocalData() || { accounts: [{id: generateId(), name: "証券口座 1", note: ""}], holdings: [] };
let fxRate = Number.isFinite(data.usdJpyRate) && data.usdJpyRate > 0 ? data.usdJpyRate : null;
let serverRevision = null;
let serverInitialized = false;
let serverConnected = false;
let snapshotResponseCache = null;
let snapshotFetchPromise = null;
let selectedAssetTrendRange = "1m";
let selectedTrendDetailRange = "1m";
let selectedTrendDetailAccountId = "total";
let versionHistoryEntries = [];
let goalSimulationChartData = [];
let latestGoalChartRender = null;

const $ = (s) => document.querySelector(s);
const cloneData = value => JSON.parse(JSON.stringify(value));
function saveCache() {
    // localStorage is only a convenience cache; a quota/privacy failure must not
    // turn a successful server save into a failed UI operation.
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* Cache is optional. */ }
  }
function showSyncNotice(message, { migration = false, retry = false } = {}) {
  const notice = $("#sync-notice");
  notice.hidden = !message;
  $("#sync-message").textContent = message || "";
  $("#migrate-local").hidden = !migration;
  $("#retry-sync").hidden = !retry;
}
function applyServerState(payload) {
  data = payload.data;
  fxRate = Number.isFinite(data.usdJpyRate) && data.usdJpyRate > 0 ? data.usdJpyRate : null;
  serverRevision = payload.revision;
  serverInitialized = Boolean(payload.initialized);
  serverConnected = true;
  saveCache();
}
async function requestServerState() {
  const response = await fetch("/api/v1/state", { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `共通データを取得できませんでした（${response.status}）`);
  return payload;
}
function preserveLocalBackup(serverData) {
  const raw = localStorage.getItem(KEY);
  if (!raw || localStorage.getItem(LOCAL_BACKUP_KEY)) return false;
  try {
    if (JSON.stringify(JSON.parse(raw)) === JSON.stringify(serverData)) return false;
    localStorage.setItem(LOCAL_BACKUP_KEY, raw);
    return true;
  } catch {
    localStorage.setItem(LOCAL_BACKUP_KEY, raw);
    return true;
  }
}
async function loadServerState() {
  try {
    const payload = await requestServerState();
    if (payload.initialized) {
      const localBackupSaved = preserveLocalBackup(payload.data);
      applyServerState(payload);
      render();
      showSyncNotice(localBackupSaved ? "この端末にあった以前のデータはバックアップとして残し、サーバーの共通データを読み込みました。自動統合はしていません。" : "");
    } else {
      serverRevision = payload.revision;
      serverInitialized = false;
      serverConnected = true;
      data.accountCategories = payload.data.accountCategories;
      render();
      showSyncNotice("共通データは未初期化です。PC側のデータを正本にする場合はPCで初回移行してください。iPhone側のデータは自動統合しません。", { migration: true });
    }
  } catch (error) {
    serverConnected = false;
    render();
    showSyncNotice(`共通サーバーに接続できません。保存済みキャッシュを表示中です。変更は保存されません。${error.message}`, { retry: true });
  }
}
async function persistState(previousData, snapshotMetadata = null) {
  try {
    if (!serverConnected || !serverInitialized || !Number.isSafeInteger(serverRevision)) {
      throw new Error("共通データが未接続または未初期化です。初回移行後に保存してください。");
    }
    const response = await fetch("/api/v1/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: serverRevision, data, ...(snapshotMetadata ? { snapshot: snapshotMetadata } : {}) })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409) {
      try {
        const latest = await requestServerState();
        if (latest.initialized) {
          preserveLocalBackup(latest.data);
          applyServerState(latest);
          render();
        }
      } catch { /* Keep the local form draft when the latest state cannot be fetched. */ }
      throw Object.assign(new Error("別の端末で更新されました。最新状態を読み込みました。入力内容を確認して、必要ならもう一度保存してください。"), { conflict: true });
    }
    if (!response.ok) throw new Error(payload.error || `保存できませんでした（${response.status}）`);
    applyServerState(payload);
    render();
    showSyncNotice("");
  } catch (error) {
    if (!error.conflict) {
      data = previousData;
      fxRate = Number.isFinite(data.usdJpyRate) && data.usdJpyRate > 0 ? data.usdJpyRate : null;
      render();
      if (error instanceof TypeError) serverConnected = false;
      showSyncNotice(`保存できませんでした。入力内容は保持しています。接続を確認して再試行してください。${error.message}`, {
        migration: serverConnected && !serverInitialized,
        retry: !serverConnected
      });
    } else {
      showSyncNotice(error.message);
    }
    throw error;
  }
}
async function migrateLocalData() {
  const button = $("#migrate-local");
  button.disabled = true;
  try {
    const localData = readLocalData() || data;
    const response = await fetch("/api/v1/migrate-local-storage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: localData })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409) {
      const latest = await requestServerState();
      preserveLocalBackup(latest.data);
      applyServerState(latest);
      render();
      showSyncNotice("別の端末ですでに初回移行が完了しています。サーバーの共通データを読み込みました。端末ごとのデータは自動統合していません。");
      return;
    }
    if (!response.ok) throw new Error(payload.error || `移行できませんでした（${response.status}）`);
    applyServerState(payload);
    render();
    showSyncNotice(`初回移行が完了しました。証券口座 ${payload.accountsCount}件、保有資産 ${payload.holdingsCount}件をサーバーに保存しました。`);
  } catch (error) {
    showSyncNotice(`初回移行に失敗しました。localStorageのデータは残っています。${error.message}`, { migration: true, retry: true });
  } finally {
    button.disabled = false;
  }
}
// 国内投信の基準価額は、通常「1万口あたり」。保有口数は実口数で入力する。
const quantityDivisor = (h) => h.type === "投資信託" ? 10000 : 1;
const hasQuote = (h) => Number.isFinite(h.price);
const formatHoldingPrice = h => {
  const amount = number.format(h.price);
  if (h.currency === "JPY") return `${amount}円`;
  if (h.currency === "USD") return `${amount}ドル`;
  return `${amount} ${escapeHTML(h.currency)}`;
};
const hasValuation = (h) => hasQuote(h) && (h.currency !== "USD" || Number.isFinite(fxRate));
const valueOf = (h) => hasValuation(h) ? h.price * h.quantity / quantityDivisor(h) * (h.currency === "USD" ? fxRate : 1) : null;
function getCurrentTotalAssets() { return data.holdings.filter(hasValuation).reduce((sum, holding) => sum + valueOf(holding), 0); }
const costOf = (h) => h.currency === "USD" && !Number.isFinite(fxRate) ? null : h.cost * h.quantity / quantityDivisor(h) * (h.currency === "USD" ? fxRate : 1);
const gainClass = (n) => n > 0 ? "positive" : n < 0 ? "negative" : "";
const signed = n => Number.isFinite(n) ? `${n > 0 ? "+" : n < 0 ? "-" : ""}${formatJpyAmount(Math.abs(n))}` : "—";
const account = (id) => data.accounts.find(a => a.id === id);

// Local-currency daily change. null means unknown/unusable; 0 means unchanged.
// A successful request is not proof of today's market data: retain the source
// priceTimestamp/priceDate for freshness decisions in a future heatmap.
function dailyChangePercent(holding) {
  if (holding.quoteStatus !== "success" || !Number.isFinite(holding.price) || holding.price < 0 ||
      !Number.isFinite(holding.previousClose) || holding.previousClose <= 0) return null;
  return (holding.price - holding.previousClose) / holding.previousClose * 100;
}

const ASSET_WEATHER = {
  storm: { label: "荒天", icon: "storm" },
  rain: { label: "雨", icon: "rain" },
  cloud: { label: "くもり", icon: "cloud" },
  "partly-cloudy": { label: "晴れ時々くもり", icon: "partly-cloudy" },
  sunny: { label: "晴れ", icon: "sunny" },
  "very-sunny": { label: "強い晴れ", icon: "very-sunny" },
  special: { label: "特別に良い状態", icon: "special" }
};
const MARKETS = [
  { market: "US", name: "米国" },
  { market: "JP", name: "日本" }
];
let marketWeatherByCode = new Map();
function renderMarketWeather() {
  const container = $("#market-weather");
  container.replaceChildren();
  const title = document.createElement("span");
  title.className = "market-weather-title";
  title.textContent = "市況";
  container.append(title);
  for (const market of MARKETS) {
    const result = marketWeatherByCode.get(market.market);
    const state = getAssetWeatherState(result?.changePercent);
    const weather = state ? ASSET_WEATHER[state] : null;
    const indices = Array.isArray(result?.indices) ? result.indices : [];
    const hasCompleteMarketData = indices.length === 2 && indices.every(index => Number.isFinite(index.changePercent)) && Number.isFinite(result?.changePercent);
    const formatMarketRate = value => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "market-weather-item";
    const marketName = market.name;
    const tooltipLines = hasCompleteMarketData
      ? [marketName + "市場", ...indices.map(index => `${index.name}  ${formatMarketRate(index.changePercent)}`), `平均  ${formatMarketRate(result.changePercent)}`]
      : [marketName + "市場", "指数データを取得できません"];
    button.title = `${tooltipLines.join("\n")}\n判定：${weather?.label || "不明"}`;
    button.setAttribute("aria-label", button.title.replaceAll("\n", "、"));
    const code = document.createElement("span");
    code.className = "market-weather-code";
    code.textContent = market.market;
    button.append(code);
    if (weather) {
      const icon = document.createElement("img");
      icon.src = `/assets/icons/asset-weather-${weather.icon}.svg`;
      icon.alt = "";
      icon.width = 22;
      icon.height = 22;
      icon.setAttribute("aria-hidden", "true");
      button.append(icon);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "market-weather-placeholder";
      placeholder.textContent = "—";
      button.append(placeholder);
    }
    if (hasCompleteMarketData) {
      const rate = document.createElement("span");
      rate.className = "market-weather-rate";
      rate.textContent = formatMarketRate(result.changePercent);
      button.append(rate);
    }
    container.append(button);
  }
}
async function loadMarketWeather() {
  try {
    const response = await fetch("/api/v1/market-weather", { cache: "no-store" });
    if (!response.ok) throw new Error(`市況データを取得できませんでした（${response.status}）`);
    const payload = await response.json();
    if (!Array.isArray(payload.markets)) throw new Error("市況データの形式が正しくありません");
    marketWeatherByCode = new Map(payload.markets.map(market => [market.market, market]));
  } catch (error) {
    console.warn(error.message);
  }
  renderMarketWeather();
}
function getAssetWeatherState(changePercent) {
  if (!Number.isFinite(changePercent)) return null;
  if (changePercent >= 5) return "special";
  if (changePercent >= 3) return "very-sunny";
  if (changePercent >= 0.5) return "sunny";
  if (changePercent >= -0.5) return "partly-cloudy";
  if (changePercent > -3) return "cloud";
  if (changePercent >= -5) return "rain";
  return "storm";
}
function renderAssetWeatherIcon(changePercent) {
  const icon = $("#asset-weather-icon");
  const state = getAssetWeatherState(changePercent);
  if (!state) {
    icon.hidden = true;
    icon.alt = "";
    icon.title = "";
    return;
  }
  const weather = ASSET_WEATHER[state];
  icon.src = `/assets/icons/asset-weather-${weather.icon}.svg`;
  icon.alt = `資産天気: ${weather.label}`;
  icon.title = weather.label;
  icon.hidden = false;
}

function render() {
  const holdings = data.holdings;
  const quoted = holdings.filter(hasQuote);
  const missingQuotes = holdings.length - quoted.length;
  const valued = holdings.filter(hasValuation);
  const total = getCurrentTotalAssets();
  const cost = valued.reduce((n,h) => n + costOf(h), 0);
  const gain = total - cost;
  const canCompareDay = holdings.length > 0 && valued.length === holdings.length && holdings.every(h => dailyChangePercent(h) !== null);
  const day = canCompareDay ? valued.reduce((n,h) => n + (h.price - h.previousClose) * h.quantity / quantityDivisor(h) * (h.currency === "USD" ? fxRate : 1), 0) : null;
  $("#total-value").innerHTML = valued.length ? formatMetricJpyAmount(total) : "—";
  $("#total-cost").textContent = valued.length ? `取得額 ${formatJpyAmount(cost)}${missingQuotes ? `（未取得 ${missingQuotes}件を除く）` : ""}` : holdings.some(h => hasQuote(h) && h.currency === "USD") ? "為替レート取得後に表示" : "価格を更新してください";
  $("#total-gain").innerHTML = valued.length ? formatMetricJpyAmount(gain, true) : "—";
  $("#total-gain").className = gainClass(gain);
  $("#total-gain-rate").textContent = cost ? `${(gain / cost * 100).toFixed(2)}%` : "—";
  $("#total-gain-rate").className = gainClass(gain);
  $("#day-gain").innerHTML = day !== null ? formatMetricJpyAmount(day, true) : "—";
  $("#day-gain").className = gainClass(day);
  const dayRate = day !== null && total - day > 0 ? day / (total - day) * 100 : null;
  $("#day-gain-rate").textContent = dayRate !== null ? `${dayRate.toFixed(2)}%` : "—";
  $("#day-gain-rate").className = gainClass(day);
  renderAssetWeatherIcon(dayRate);
  $("#asset-count").textContent = holdings.length ? `${holdings.length} 銘柄` : "";
  $("#quote-status").textContent = holdings.length ? `価格取得済み ${quoted.length}/${holdings.length}件${missingQuotes ? ` ／ 未取得 ${missingQuotes}件` : ""}` : "登録済みの銘柄はありません";
  const failedQuotes = holdings.filter(h => h.quoteStatus === "failed").length;
  if (failedQuotes) $("#quote-status").textContent += ` ／ 今回取得失敗 ${failedQuotes}件（取得済みの価格は保持）`;
  $("#last-fetch-at").textContent = data.lastQuoteFetchedAt ? `最終取得 ${formatDateTime(data.lastQuoteFetchedAt)}` : "";
  renderMarketWeather();
  $("#usd-jpy-rate").textContent = Number.isFinite(fxRate) ? `USD/JPY ${fxRate.toFixed(2)}` : "USD/JPY —";
  $("#usd-jpy-timestamp").textContent = Number.isFinite(data.usdJpyTimestamp) ? `為替日時 ${formatDateTime(data.usdJpyTimestamp)}` : "";
  const heatmapGroups = groupHeatmapHoldings(holdings);
  renderAllocation(total); renderAccountSummary(); renderAssetHeatmap(heatmapGroups); renderAssetHeatmapDetail(heatmapGroups); renderDashboardHoldings(); renderHoldingsTable(); renderAccounts(); renderAccountOptions(); renderTrendDetailAccountOptions();
  if (snapshotResponseCache && $("#trend-view").classList.contains("active")) renderAssetTrendDetail(snapshotResponseCache);
}
function formatGoalDate(yearMonth) {
  const match = typeof yearMonth === "string" ? yearMonth.match(/^(\d{4})-(\d{2})$/) : null;
  return match ? `${Number(match[1])}年${Number(match[2])}月` : "—";
}
function formatGoalDuration(months) {
  if (!Number.isInteger(months) || months < 0) return "--";
  if (months < 12) return `${months}か月`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  return remainingMonths ? `${years}年${remainingMonths}か月` : `${years}年`;
}
function clearGoalSimulationResults(message = "条件を入力して「シミュレーション」を実行してください。") {
  const donut = $("#goal-achievement-donut");
  $("#goal-result-state-label").textContent = "—";
  $("#goal-result-primary-label").textContent = "—";
  $("#goal-result-primary-value").textContent = "—";
  $("#goal-result-secondary-label").textContent = "—";
  $("#goal-result-secondary-value").textContent = "—";
  $("#goal-result-achievement").textContent = "—";
  $("#goal-result-secondary-highlight").hidden = false;
  donut.style.setProperty("--goal-achievement-progress", "0%");
  donut.dataset.achievementRate = "";
  donut.setAttribute("aria-label", "目標達成率 —");
  $("#goal-summary-detail").textContent = message;
  $("#goal-summary").dataset.state = "empty";
  $("#goal-result-panel").dataset.hasResult = "false";
  $("#goal-result-panel").dataset.state = "empty";
  clearGoalChart();
}
let goalChartSize = { width: 1000, height: 330, left: 82, right: 984, top: 28, bottom: 295 };
function formatGoalChartAmount(amount) {
  const sign = amount < 0 ? "−" : "";
  const absolute = Math.abs(amount);
  if (absolute >= 100000000) return `${sign}${(absolute / 100000000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}億円`;
  if (absolute >= 10000) return `${sign}${Math.round(absolute / 10000).toLocaleString("ja-JP")}万円`;
  return `${sign}${Math.round(absolute).toLocaleString("ja-JP")}円`;
}
function getGoalChartTickStep(minValue, maxValue, maxTickCount = 7) {
  const axisReference = Math.max(Math.abs(minValue), Math.abs(maxValue), 1);
  const baselineStep = 10 ** (Math.floor(Math.log10(axisReference)) - 1);
  const minimumStep = Math.max(baselineStep, (maxValue - minValue) / (maxTickCount - 1));
  const firstExponent = Math.floor(Math.log10(minimumStep));
  for (let exponent = firstExponent - 1; exponent <= firstExponent + 8; exponent += 1) {
    for (const multiplier of [1, 2, 5]) {
      const step = multiplier * 10 ** exponent;
      if (step < minimumStep) continue;
      const tickCount = Math.floor(maxValue / step) - Math.floor(minValue / step) + 2;
      if (tickCount <= maxTickCount) return step;
    }
  }
  return 10 ** (firstExponent + 9);
}
function clearGoalChart() {
  goalSimulationChartData = [];
  latestGoalChartRender = null;
  $("#goal-chart").replaceChildren();
  $("#goal-chart-tooltip").hidden = true;
  $("#goal-chart-panel").hidden = true;
  $("#goal-annual-returns-panel").hidden = true;
  $("#goal-annual-returns-body").replaceChildren();
}
function buildGoalAnnualReturnData(simulationData) {
  if (!Array.isArray(simulationData)) return [];
  const points = simulationData
    .filter(point => typeof point?.date === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(point.date)
      && Number.isFinite(point.assets) && Number.isFinite(point.cumulativeContribution))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const annualData = [];
  let previousPoint = null;
  for (const point of points) {
    const year = Number(point.date.slice(0, 4));
    let annual = annualData.at(-1);
    if (!annual || annual.year !== year) {
      annual = {
        year,
        startAssets: previousPoint ? previousPoint.assets : point.assets,
        endAssets: point.assets,
        annualContribution: 0,
        cumulativeContribution: point.cumulativeContribution,
        cumulativeInvestmentGain: point.investmentGain,
      };
      annualData.push(annual);
    }
    if (previousPoint) {
      annual.annualContribution += point.cumulativeContribution - previousPoint.cumulativeContribution;
    }
    annual.endAssets = point.assets;
    annual.cumulativeContribution = point.cumulativeContribution;
    annual.cumulativeInvestmentGain = Number.isFinite(point.investmentGain)
      ? point.investmentGain
      : point.assets - points[0].assets - point.cumulativeContribution;
    previousPoint = point;
  }
  return annualData.map(annual => {
    const annualInvestmentGain = annual.endAssets - annual.startAssets - annual.annualContribution;
    return {
      ...annual,
      annualInvestmentGain,
      annualReturnRate: annual.startAssets === 0 ? null : annualInvestmentGain / annual.startAssets * 100,
    };
  });
}
function renderGoalAnnualReturns(simulationData) {
  const panel = $("#goal-annual-returns-panel");
  const body = $("#goal-annual-returns-body");
  const rows = buildGoalAnnualReturnData(simulationData);
  body.innerHTML = rows.map(row => {
    const signedAmount = value => `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatJpyAmount(Math.abs(value))}`;
    const rate = Number.isFinite(row.annualReturnRate)
      ? `${row.annualReturnRate > 0 ? "+" : ""}${row.annualReturnRate.toFixed(2)}%`
      : "—";
    const gainClassName = row.annualInvestmentGain > 0 ? "positive" : row.annualInvestmentGain < 0 ? "negative" : "";
    const rateClassName = row.annualReturnRate > 0 ? "positive" : row.annualReturnRate < 0 ? "negative" : "";
    return `<tr><th scope="row">${row.year}年</th><td>${formatJpyAmount(row.startAssets)}</td><td>${formatJpyAmount(row.endAssets)}</td><td>${formatJpyAmount(row.annualContribution)}</td><td class="${gainClassName}">${signedAmount(row.annualInvestmentGain)}</td><td class="${rateClassName}">${rate}</td></tr>`;
  }).join("");
  panel.hidden = rows.length === 0;
}
const GOAL_RESULT_MESSAGE_DEFINITIONS = {
  achieved: {
    label: "達成済み",
    primaryLabel: "目標超過",
    primaryValue: ({ result, targetAssets }) => {
      const currentAssets = result.simulationData?.[0]?.assets ?? targetAssets;
      return `+${formatJpyAmount(Math.max(0, currentAssets - targetAssets))}`;
    },
    secondaryLabel: "",
    secondaryValue: () => "",
    summaryDetail: ({ targetAssets }) => `現在の資産額は目標の${formatGoalChartAmount(targetAssets)}に到達しています。`,
  },
  projected: {
    label: "達成見込み",
    primaryLabel: "達成予想",
    primaryValue: ({ result }) => formatGoalDate(result.estimatedGoalDate),
    secondaryLabel: "あと",
    secondaryValue: ({ result }) => formatGoalDuration(result.monthsToGoal),
    summaryDetail: ({ targetAssets }) => `現在の条件を継続すると、目標${formatGoalChartAmount(targetAssets)}を達成可能です。`,
  },
  unmet: {
    label: "期間内に未達",
    primaryLabel: "終了時予想資産",
    primaryValue: ({ result }) => formatJpyAmount(result.finalAssets),
    secondaryLabel: "目標まで",
    secondaryValue: ({ result, targetAssets }) => `${formatJpyAmount(Math.max(0, targetAssets - result.finalAssets))}不足`,
    summaryDetail: ({ result }) => `期間終了時点の予想資産は${Number.isFinite(result.finalAssets) ? formatGoalChartAmount(result.finalAssets) : "—"}です。`,
  },
};
function getGoalResultMessageState(result, targetAssets) {
  const currentAssets = result.simulationData?.[0]?.assets;
  if ((Number.isFinite(currentAssets) && currentAssets >= targetAssets) || result.monthsToGoal === 0) return "achieved";
  if (result.reachedGoal === true && result.monthsToGoal > 0) return "projected";
  return "unmet";
}
function renderGoalResultMessage(result, targetAssets) {
  const state = getGoalResultMessageState(result, targetAssets);
  const definition = GOAL_RESULT_MESSAGE_DEFINITIONS[state];
  const values = { result, targetAssets };
  $("#goal-result-panel").dataset.state = state;
  $("#goal-result-state-label").textContent = definition.label;
  $("#goal-result-primary-label").textContent = definition.primaryLabel;
  $("#goal-result-primary-value").textContent = definition.primaryValue(values);
  $("#goal-result-secondary-label").textContent = definition.secondaryLabel;
  $("#goal-result-secondary-value").textContent = definition.secondaryValue(values);
  $("#goal-result-secondary-highlight").hidden = state === "achieved";
  $("#goal-summary-detail").textContent = definition.summaryDetail(values);
  $("#goal-summary").dataset.state = state;
}
function renderGoalChart(result, targetAssets) {
  const panel = $("#goal-chart-panel");
  const svg = $("#goal-chart");
  const tooltip = $("#goal-chart-tooltip");
  clearGoalChart();
  const rawData = Array.isArray(result.simulationData) ? result.simulationData : [];
  const simulationData = rawData.map((point, index) => {
    const validDate = typeof point?.date === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(point.date);
    return Number.isInteger(point?.month) && point.month >= 0 && validDate && Number.isFinite(point.assets)
      ? { point, index }
      : null;
  });
  const validPoints = simulationData.filter(Boolean);
  if (!validPoints.length || !Number.isFinite(targetAssets)) return;

  goalSimulationChartData = rawData;
  panel.hidden = false;
  renderGoalAnnualReturns(rawData);
  const width = Math.max(svg.clientWidth || 360, 300);
  const isMobileGoalChart = window.innerWidth <= 600;
  const height = svg.clientHeight || (isMobileGoalChart ? 270 : 330);
  goalChartSize = {
    width,
    height,
    left: isMobileGoalChart ? 72 : 82,
    right: width - (isMobileGoalChart ? 8 : 18),
    top: 27,
    bottom: height - 35,
  };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const { left, right, top, bottom } = goalChartSize;
  latestGoalChartRender = { result, targetAssets };
  const startPoint = validPoints.find(({ point }) => point.month === 0)?.point || validPoints[0].point;
  const [, startYear, startMonth] = startPoint.date.match(/^(\d{4})-(\d{2})$/);
  const startMonthOffset = Number(startMonth) - 1;
  const lastMonth = Math.max(0, ...validPoints.map(({ point }) => point.month));
  const reachedMonth = result.reachedGoal && Number.isInteger(result.monthsToGoal) && result.monthsToGoal >= 0
    ? result.monthsToGoal
    : null;
  const simulationEndOffset = reachedMonth === null ? lastMonth : Math.max(lastMonth, reachedMonth) + 12;
  const xAxisLastMonth = startMonthOffset + simulationEndOffset;
  const xFor = point => xAxisLastMonth === 0
    ? (left + right) / 2
    : left + (startMonthOffset + point.month) / xAxisLastMonth * (right - left);
  const rawMin = Math.min(targetAssets, ...validPoints.map(({ point }) => point.assets));
  const rawMax = Math.max(targetAssets, ...validPoints.map(({ point }) => point.assets));
  const tickStep = getGoalChartTickStep(rawMin, rawMax);
  const minValue = Math.floor(rawMin / tickStep) * tickStep;
  const maxValue = (Math.floor(rawMax / tickStep) + 1) * tickStep;
  const valueSpan = maxValue - minValue || 1;
  const yFor = value => bottom - (value - minValue) / valueSpan * (bottom - top);
  const pathSegments = [];
  let currentSegment = [];
  for (const entry of simulationData) {
    if (!entry) {
      if (currentSegment.length) pathSegments.push(currentSegment);
      currentSegment = [];
      continue;
    }
    currentSegment.push({ x: xFor(entry.point), y: yFor(entry.point.assets), point: entry.point, index: entry.index });
  }
  if (currentSegment.length) pathSegments.push(currentSegment);
  const linePath = pathSegments.map(segment => segment.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ")).join(" ");
  const areaPaths = pathSegments.filter(segment => segment.length > 1).map(segment => {
    const first = segment[0], last = segment.at(-1);
    return `${segment.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ")} L${last.x.toFixed(2)},${bottom} L${first.x.toFixed(2)},${bottom} Z`;
  }).join(" ");
  const minTickIndex = Math.floor(rawMin / tickStep);
  const maxTickIndex = Math.floor(rawMax / tickStep) + 1;
  const ticks = Array.from({ length: maxTickIndex - minTickIndex + 1 }, (_, index) => (minTickIndex + index) * tickStep);
  const yAxis = ticks.map(value => {
    const y = yFor(value);
    return `<line class="goal-chart-gridline" x1="${left}" y1="${y.toFixed(2)}" x2="${right}" y2="${y.toFixed(2)}"/><text class="goal-chart-y-label" x="${left - 13}" y="${(y + 5).toFixed(2)}" text-anchor="end">${formatGoalChartAmount(value)}</text>`;
  }).join("");
  const endpointYear = Number(startYear) + Math.floor(xAxisLastMonth / 12);
  const xLabels = [{ monthOffset: 0, year: Number(startYear) }];
  const simulationPeriodMonths = reachedMonth === null ? lastMonth : Math.max(lastMonth, reachedMonth);
  const baseLabelIntervalMonths = isMobileGoalChart
    ? simulationPeriodMonths < 36 ? 12 : simulationPeriodMonths <= 72 ? 24 : 48
    : simulationPeriodMonths < 24 ? 6 : simulationPeriodMonths <= 72 ? 12 : 24;
  const minimumLabelSpacing = isMobileGoalChart ? 50 : 44;
  const maxLabelIntervals = Math.max(1, Math.floor((right - left) / minimumLabelSpacing));
  const desiredLabelIntervals = Math.ceil(xAxisLastMonth / baseLabelIntervalMonths);
  const labelIntervalMonths = baseLabelIntervalMonths * Math.max(1, Math.ceil(desiredLabelIntervals / maxLabelIntervals));
  for (let monthOffset = labelIntervalMonths; monthOffset <= xAxisLastMonth; monthOffset += labelIntervalMonths) {
    const year = Number(startYear) + Math.floor(monthOffset / 12);
    const monthWithinYear = monthOffset % 12;
    if (reachedMonth !== null && endpointYear % 2 !== 0 && year === endpointYear && monthWithinYear === 0) continue;
    xLabels.push({ monthOffset, year, monthWithinYear });
  }
  const hasEndpointYearLabel = xLabels.some(({ year }) => year === endpointYear);
  const endpointFitsLabelCadence = !isMobileGoalChart
    || ((endpointYear - Number(startYear)) * 12) % labelIntervalMonths === 0;
  if (reachedMonth !== null && endpointYear % 2 === 0 && endpointFitsLabelCadence && !hasEndpointYearLabel) {
    xLabels.push({ monthOffset: (endpointYear - Number(startYear)) * 12, year: endpointYear });
  }
  xLabels.sort((a, b) => a.monthOffset - b.monthOffset);
  const xAxis = xLabels.map(({ monthOffset, year, monthWithinYear = 0 }, index) => {
    const x = xAxisLastMonth === 0 ? (left + right) / 2 : left + monthOffset / xAxisLastMonth * (right - left);
    const anchor = index === 0 ? "start" : index === xLabels.length - 1 ? "end" : "middle";
    const label = monthWithinYear === 6 ? "7月" : String(year);
    return `<text class="goal-chart-x-label" x="${x.toFixed(2)}" y="${height - 13}" text-anchor="${anchor}">${label}</text>`;
  }).join("");
  const goalPointData = reachedMonth !== null
    ? rawData[result.monthsToGoal]
    : null;
  const goalPoint = goalPointData && Number.isFinite(goalPointData.assets)
    ? validPoints.find(({ point, index }) => index === result.monthsToGoal && point.month === result.monthsToGoal)
    : null;
  const goalX = goalPoint ? xFor(goalPoint.point) : null;
  const goalY = goalPoint ? yFor(goalPoint.point.assets) : null;
  const goalGuide = goalPoint
    ? `<line class="goal-chart-goal-guide" x1="${goalX.toFixed(2)}" y1="${goalY.toFixed(2)}" x2="${goalX.toFixed(2)}" y2="${bottom}"/>`
    : "";
  const targetY = yFor(targetAssets);
  const stride = Math.max(1, Math.ceil(lastMonth / Math.max(1, Math.floor((right - left) / 28))));
  const sampled = validPoints.filter(({ point, index }) => index === 0 || index === rawData.length - 1 || point.month % stride === 0 || (goalPoint && point.month === goalPoint.point.month));
  const hits = sampled.map(({ point, index }) => {
    const x = xFor(point), y = yFor(point.assets);
    const date = formatGoalDate(point.date);
    const label = `${date}、予想資産 ${formatJpyAmount(point.assets)}`;
    return `<circle class="goal-chart-hit" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="12" data-goal-chart-index="${index}" data-x="${x.toFixed(2)}" data-y="${y.toFixed(2)}" tabindex="0" role="button" aria-label="${label}"/>`;
  }).join("");
  const visibleDots = sampled.map(({ point }) => `<circle class="goal-chart-sample" cx="${xFor(point).toFixed(2)}" cy="${yFor(point.assets).toFixed(2)}" r="3.2"/>`).join("");
  const goalMarker = goalPoint
    ? `<circle class="goal-chart-goal-marker" cx="${goalX.toFixed(2)}" cy="${goalY.toFixed(2)}" r="8"/><text class="goal-chart-goal-label" x="${goalX > (left + right) / 2 ? goalX - 12 : goalX + 12}" y="${Math.max(top + 16, goalY - 14)}" text-anchor="${goalX > (left + right) / 2 ? "end" : "start"}">達成 ${formatGoalDate(goalPoint.point.date)}</text>`
    : "";
  const targetLine = `<line class="goal-chart-target" x1="${left}" y1="${targetY.toFixed(2)}" x2="${right}" y2="${targetY.toFixed(2)}"/>`;
  svg.setAttribute("aria-label", `資産推移。目標 ${formatJpyAmount(targetAssets)}${goalPoint ? `、目標達成 ${formatGoalDate(goalPoint.point.date)}` : ""}`);
  svg.innerHTML = `<defs><linearGradient id="goal-chart-area-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="var(--teal)" stop-opacity=".2"/><stop offset="100%" stop-color="var(--teal)" stop-opacity=".015"/></linearGradient></defs>${yAxis}${areaPaths ? `<path class="goal-chart-area" d="${areaPaths}"/>` : ""}${goalGuide}${linePath ? `<path class="goal-chart-line" d="${linePath}"/>` : ""}${validPoints.length === 1 ? `<circle class="goal-chart-single-point" cx="${xFor(validPoints[0].point).toFixed(2)}" cy="${yFor(validPoints[0].point.assets).toFixed(2)}" r="5"/>` : ""}${visibleDots}${targetLine}${goalMarker}${hits}<line class="goal-chart-x-axis" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/>${xAxis}`;
  tooltip.hidden = true;
}
function showGoalChartTooltip(hit) {
  if (!hit) return;
  const point = goalSimulationChartData[Number(hit.dataset.goalChartIndex)];
  if (!point || !Number.isFinite(point.assets)) return;
  const tooltip = $("#goal-chart-tooltip");
  tooltip.replaceChildren();
  const date = document.createElement("strong");
  date.textContent = formatGoalDate(point.date);
  const amount = document.createElement("span");
  amount.textContent = `予想資産 ${formatJpyAmount(point.assets)}`;
  tooltip.append(date, amount);
  const svgRect = $("#goal-chart").getBoundingClientRect();
  const chartRect = $("#goal-chart").parentElement.getBoundingClientRect();
  const x = svgRect.left + Number(hit.dataset.x) / goalChartSize.width * svgRect.width - chartRect.left;
  const y = svgRect.top + Number(hit.dataset.y) / goalChartSize.height * svgRect.height - chartRect.top;
  tooltip.style.left = `${Math.max(75, Math.min(chartRect.width - 75, x))}px`;
  tooltip.style.top = `${y < 82 ? y + 24 : y - 10}px`;
  tooltip.classList.toggle("is-below", y < 82);
  tooltip.hidden = false;
}
function renderGoalSimulationResults(result, targetAssets) {
  const donut = $("#goal-achievement-donut");
  const achievementRate = result.achievementRate;
  const ringProgress = Math.min(Math.max(achievementRate, 0), 100);
  $("#goal-result-achievement").textContent = `${achievementRate.toFixed(2)}%`;
  donut.style.setProperty("--goal-achievement-progress", `${ringProgress}%`);
  donut.dataset.achievementRate = String(result.achievementRate);
  donut.setAttribute("aria-label", `目標達成率 ${result.achievementRate.toFixed(2)}%`);
  renderGoalResultMessage(result, targetAssets);
  $("#goal-result-panel").dataset.hasResult = "true";
  renderGoalChart(result, targetAssets);
}
function runGoalSimulation(event) {
  event.preventDefault();
  const currentAssetsInput = $("#goal-current-assets");
  const targetAssetsInput = $("#goal-target-assets");
  const monthlyContributionInput = $("#goal-monthly-contribution");
  const currentAssetsRaw = currentAssetsInput.value.trim().replaceAll(",", "");
  const targetAssetsRaw = targetAssetsInput.value.trim().replaceAll(",", "");
  const monthlyContributionRaw = monthlyContributionInput.value.trim().replaceAll(",", "");
  const annualRateInput = $("#goal-annual-return").value.trim();
  const emptyInputMessage = [
    [currentAssetsRaw, "現在資産を入力してください。"],
    [targetAssetsRaw, "目標資産を入力してください。"],
    [monthlyContributionRaw, "毎月積立額を入力してください。0円の場合は0を入力してください。"],
    [annualRateInput, "想定年利を入力してください。"]
  ].find(([value]) => !value)?.[1];
  if (emptyInputMessage) {
    clearGoalSimulationResults("入力値を確認して、もう一度シミュレーションしてください。");
    $("#goal-error").textContent = emptyInputMessage;
    $("#goal-error").hidden = false;
    return;
  }
  const currentAssets = Number(currentAssetsRaw);
  const targetAssets = Number(targetAssetsRaw);
  const monthlyContribution = Number(monthlyContributionRaw);
  const annualReturnRate = annualRateInput === "" ? NaN : Number(annualRateInput);
  const now = new Date();
  const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  $("#goal-error").hidden = true;
  $("#goal-error").textContent = "";
  try {
    const result = AssetGoalSimulation.calculateAssetGoalSimulation({
      currentAssets,
      targetAssets,
      monthlyContribution,
      annualReturnRate,
      startDate
    });
    renderGoalSimulationResults(result, targetAssets);
  } catch (error) {
    clearGoalSimulationResults("入力値を確認して、もう一度シミュレーションしてください。");
    const message = error.message || "入力値を確認してください。";
    $("#goal-error").textContent = message.includes("targetAssets")
      ? "目標資産は0円より大きい値を入力してください。"
      : message.includes("currentAssets")
        ? "現在資産は0円以上で入力してください。"
        : message.includes("monthlyContribution")
          ? "毎月積立額は0円以上で入力してください。"
          : message.includes("annualReturnRate")
            ? "想定年利は-100%より大きい値を入力してください。"
            : "入力値を確認してください。";
    $("#goal-error").hidden = false;
  }
}
function renderAllocation(total) {
  const types = ["日本株", "米国株", "投資信託"].map(type => [type, data.holdings.filter(h => h.type === type && hasValuation(h)).reduce((n,h) => n + valueOf(h), 0)]).filter(x => x[1]);
  $("#allocation").className = types.length ? "allocation" : "allocation empty-state";
  if (!types.length) {
    $("#allocation").innerHTML = "保有資産を追加すると配分を表示します";
    return;
  }

  const colors = ["#16736b", "#3b9c8e", "#d7a947"];
  let angle = 0;
  const segments = types.map(([, value], index) => {
    const nextAngle = angle + value / total * 360;
    const segment = `${colors[index]} ${angle}deg ${nextAngle}deg`;
    angle = nextAngle;
    return segment;
  }).join(", ");
  const details = types.map(([type, value], index) => {
    const percentage = value / total * 100;
    return `<li class="allocation-legend-row"><span class="allocation-legend-name"><i style="--allocation-color:${colors[index]}"></i>${type}</span><span class="allocation-legend-values"><b>${percentage.toFixed(1)}%</b><small>${formatJpyAmount(value)}</small></span></li>`;
  }).join("");
  $("#allocation").innerHTML = `<div class="allocation-chart-layout"><div class="allocation-donut" role="img" aria-label="資産配分 ${types.map(([type, value]) => `${type} ${(value / total * 100).toFixed(1)}%`).join("、")}" style="--allocation-chart:conic-gradient(${segments})"><div class="allocation-donut-center"><small>構成比</small></div></div><ul class="allocation-legend">${details}</ul></div>`;
}
function renderAccountSummary() {
  const rows = data.accounts.map(a => {
    const valued = data.holdings.filter(h => h.accountId === a.id && hasValuation(h));
    const value = valued.reduce((sum, h) => sum + valueOf(h), 0);
    const cost = valued.reduce((sum, h) => sum + costOf(h), 0);
    const gain = valued.length ? value - cost : null;
    const rate = gain !== null && cost > 0 ? gain / cost * 100 : null;
    return `<div class="account-summary-row"><span class="account-summary-name">${escapeHTML(a.name)}</span><b class="account-summary-value">${valued.length ? formatJpyAmount(value) : "—"}</b><span class="account-summary-gain ${gainClass(gain || 0)}">${gain !== null ? signed(gain) : "—"}</span><span class="account-summary-rate">${renderHoldingRateBadge(rate)}</span></div>`;
  }).join("");
  $("#account-summary").className = rows ? "account-summary" : "account-summary empty-state";
  const header = `<div class="account-summary-header"><span>口座名</span><span>評価額</span><span class="account-summary-gain-heading">評価損益</span><span>評価損益率</span></div>`;
  $("#account-summary").innerHTML = rows ? header + rows : "証券口座を追加してください";
}
function groupHeatmapHoldings(holdings) {
  const groups = new Map();
  for (const holding of holdings) {
    const key = `${holding.type}\u0000${holding.currency}\u0000${normalizeStoredSymbol(holding.type, holding.symbol).toUpperCase()}`;
    if (!groups.has(key)) groups.set(key, { representative: holding, valueJpy: 0, valuedCount: 0, holdingCount: 0, changes: [], hasFailed: false });
    const group = groups.get(key);
    group.holdingCount++;
    const value = valueOf(holding);
    if (Number.isFinite(value) && value > 0) {
      group.valueJpy += value;
      group.valuedCount++;
    }
    if (holding.quoteStatus === "failed") group.hasFailed = true;
    const change = dailyChangePercent(holding);
    if (change === null) group.changes.push(null);
    else group.changes.push(change);
  }
  return [...groups.values()]
    .map(group => {
      const validChanges = group.changes.filter(change => change !== null);
      const allChangesAgree = validChanges.length === group.changes.length && validChanges.length > 0 &&
        validChanges.every(change => Math.abs(change - validChanges[0]) < 0.000001);
      return {
        ...group,
        changePercent: !group.hasFailed && allChangesAgree ? validChanges[0] : null
      };
    })
    .sort((a, b) => {
      const aHasValue = a.valuedCount > 0 && Number.isFinite(a.valueJpy) && a.valueJpy > 0;
      const bHasValue = b.valuedCount > 0 && Number.isFinite(b.valueJpy) && b.valueJpy > 0;
      if (aHasValue !== bHasValue) return aHasValue ? -1 : 1;
      return b.valueJpy - a.valueJpy;
    });
}

function heatmapMovementClass(changePercent) {
  if (changePercent === null || !Number.isFinite(changePercent)) return "unknown";
  const magnitude = Math.abs(changePercent);
  if (magnitude < 0.25) return "neutral";
  const level = magnitude < 1 ? 1 : magnitude < 2.5 ? 2 : magnitude < 5 ? 3 : 4;
  return `${changePercent > 0 ? "positive" : "negative"}-${level}`;
}

function renderHeatmapTiles(groups, { fullTypes = false } = {}) {
  return groups.map(group => {
    const holding = group.representative;
    const symbol = displaySymbol(holding.type, holding.symbol || holding.name || "—");
    const label = holding.type === "投資信託" ? String(holding.name || "").trim() || symbol : symbol;
    const change = group.changePercent === null ? "—" : `${group.changePercent > 0 ? "+" : ""}${group.changePercent.toFixed(1)}%`;
    const kind = fullTypes ? holding.type : holding.type === "投資信託" ? "投信" : holding.type;
    const name = `${holding.name || symbol}（${symbol}）`;
    const changeLabel = group.changePercent === null ? "本日の騰落率は不明" : `本日の騰落率 ${change}`;
    return `<article class="heatmap-tile" role="group" aria-label="${escapeHTML(name)}・${formatJpyAmount(group.valueJpy)}・${changeLabel}" data-movement="${heatmapMovementClass(group.changePercent)}" title="${escapeHTML(name)}・${formatJpyAmount(group.valueJpy)}・${changeLabel}"><span class="heatmap-symbol">${escapeHTML(label)}</span><strong class="heatmap-change">${change}</strong><small class="heatmap-type">${escapeHTML(kind)}</small></article>`;
  }).join("");
}

function treemapAreaShares(groups) {
  if (!groups.length) return [];
  const minimumShare = Math.min(0.0075, 0.4 / groups.length);
  const shares = Array(groups.length).fill(null);
  let remaining = groups.map((group, index) => ({ index, value: group.valueJpy }));
  let areaLeft = 1;
  while (remaining.length) {
    const valueLeft = remaining.reduce((sum, item) => sum + item.value, 0);
    const undersized = remaining.filter(item => item.value / valueLeft * areaLeft < minimumShare);
    if (!undersized.length) {
      for (const item of remaining) shares[item.index] = item.value / valueLeft * areaLeft;
      break;
    }
    for (const item of undersized) {
      shares[item.index] = minimumShare;
      areaLeft -= minimumShare;
    }
    const fixed = new Set(undersized.map(item => item.index));
    remaining = remaining.filter(item => !fixed.has(item.index));
  }
  return shares;
}

function binaryTreemap(groups, aspectRatio) {
  const shares = treemapAreaShares(groups);
  const items = groups.map((group, index) => ({ group, index, share: shares[index] }));
  const rectangles = [];
  function split(itemsToPlace, x, y, width, height) {
    if (itemsToPlace.length === 1) {
      rectangles.push({ ...itemsToPlace[0], x, y, width, height });
      return;
    }
    const totalShare = itemsToPlace.reduce((sum, item) => sum + item.share, 0);
    let splitAt = 1;
    let prefix = itemsToPlace[0].share;
    let bestDistance = Math.abs(prefix - totalShare / 2);
    let bestPrefix = prefix;
    for (let index = 2; index < itemsToPlace.length; index++) {
      prefix += itemsToPlace[index - 1].share;
      const distance = Math.abs(prefix - totalShare / 2);
      if (distance < bestDistance) {
        splitAt = index;
        bestDistance = distance;
        bestPrefix = prefix;
      }
    }
    const first = itemsToPlace.slice(0, splitAt);
    const second = itemsToPlace.slice(splitAt);
    const firstShare = bestPrefix / totalShare;
    if (width >= height) {
      const firstWidth = width * firstShare;
      split(first, x, y, firstWidth, height);
      split(second, x + firstWidth, y, width - firstWidth, height);
    } else {
      const firstHeight = height * firstShare;
      split(first, x, y, width, firstHeight);
      split(second, x, y + firstHeight, width, height - firstHeight);
    }
  }
  if (items.length) split(items, 0, 0, aspectRatio, 1);
  return rectangles.sort((a, b) => a.index - b.index);
}

function renderHeatmapTreemap(groups) {
  const aspectRatio = window.innerWidth <= 600 ? 0.82 : window.innerWidth <= 900 ? 1.15 : 1.7;
  const rectangles = binaryTreemap(groups, aspectRatio);
  const tiles = rectangles.map(rectangle => {
    const holding = rectangle.group.representative;
    const symbol = displaySymbol(holding.type, holding.symbol || holding.name || "—");
    const isFund = holding.type === "投資信託";
    const primaryLabel = isFund ? String(holding.name || symbol).trim() : symbol;
    const change = rectangle.group.changePercent === null ? "—" : `${rectangle.group.changePercent > 0 ? "+" : ""}${rectangle.group.changePercent.toFixed(1)}%`;
    const share = rectangle.share;
    const labelDensity = share < 0.02 ? "symbol" : share < 0.055 ? "compact" : "full";
    const name = `${holding.name || symbol}（${symbol}）`;
    const kind = holding.type;
    const changeLabel = rectangle.group.changePercent === null ? "本日の騰落率は不明" : `本日の騰落率 ${change}`;
    const position = `left:${rectangle.x / aspectRatio * 100}%;top:${rectangle.y * 100}%;width:${rectangle.width / aspectRatio * 100}%;height:${rectangle.height * 100}%`;
    return `<article class="heatmap-treemap-tile" role="group" aria-label="${escapeHTML(name)}・${formatJpyAmount(rectangle.group.valueJpy)}・${changeLabel}" data-movement="${heatmapMovementClass(rectangle.group.changePercent)}" data-label-density="${labelDensity}" data-asset-type="${isFund ? "fund" : "stock"}" style="${position}" title="${escapeHTML(name)}・${formatJpyAmount(rectangle.group.valueJpy)}・${changeLabel}"><span class="heatmap-treemap-symbol${isFund ? " heatmap-treemap-fund-name" : ""}">${escapeHTML(primaryLabel)}</span><strong class="heatmap-treemap-change">${change}</strong><small class="heatmap-treemap-type">${escapeHTML(kind)}</small></article>`;
  }).join("");
  return `<div class="heatmap-treemap-canvas" style="--treemap-aspect:${aspectRatio}">${tiles}</div>`;
}

function renderAssetHeatmap(groups) {
  const container = $("#asset-heatmap");
  const holdings = data.holdings || [];
  if (!holdings.length) {
    container.className = "asset-heatmap empty-state";
    container.innerHTML = `<p class="asset-heatmap-message">保有資産を追加すると表示します</p>`;
    return;
  }
  const topGroups = groups.filter(group => group.valuedCount > 0 && group.valueJpy > 0).slice(0, 8);
  if (!topGroups.length) {
    container.className = "asset-heatmap empty-state";
    container.innerHTML = `<p class="asset-heatmap-message">評価額が取得済みの保有資産はありません</p>`;
    return;
  }
  container.className = "asset-heatmap";
  container.innerHTML = renderHeatmapTiles(topGroups);
}

function renderAssetHeatmapDetail(groups) {
  const container = $("#asset-heatmap-detail");
  const holdings = data.holdings || [];
  $("#asset-heatmap-detail-count").textContent = `${groups.length}銘柄`;
  if (!holdings.length) {
    container.className = "heatmap-detail-content empty-state";
    container.innerHTML = `<p class="asset-heatmap-message">保有資産を追加すると表示します</p>`;
    return;
  }
  if (!groups.length) {
    container.className = "heatmap-detail-content empty-state";
    container.innerHTML = `<p class="asset-heatmap-message">評価額が取得済みの保有資産はありません</p>`;
    return;
  }
  const valuedGroups = groups.filter(group => group.valuedCount > 0 && group.valueJpy > 0);
  const unvaluedGroups = groups.filter(group => group.valuedCount === 0 || !(group.valueJpy > 0));
  const tiles = valuedGroups.length ? renderHeatmapTreemap(valuedGroups) : `<p class="asset-heatmap-message">評価額のある銘柄はありません</p>`;
  const unvalued = unvaluedGroups.length ? `<section class="heatmap-unvalued"><h3>評価額未取得・0円 <small>${unvaluedGroups.length}銘柄</small></h3><ul>${unvaluedGroups.map(group => {
    const holding = group.representative;
    const symbol = displaySymbol(holding.type, holding.symbol || holding.name || "—");
    const kind = holding.type === "投資信託" ? "投信" : holding.type;
    return `<li><span><strong>${escapeHTML(symbol)}</strong><small>${escapeHTML(holding.name || symbol)} · ${escapeHTML(kind)}</small></span><b>評価額 —</b></li>`;
  }).join("")}</ul></section>` : "";
  container.className = "heatmap-detail-content";
  container.innerHTML = `${tiles}${unvalued}`;
}
function formatHoldingQuantity(h) {
  return Number.isFinite(h.quantity) ? HoldingNumberRules.format(h.quantity) + (h.type === "投資信託" ? " 口" : " 株") : "—";
}
function renderHoldingMeta(h) {
  return escapeHTML(displaySymbol(h.type, h.symbol)) + " · " + escapeHTML(account(h.accountId)?.name || "—") + '<span class="holding-meta-type"> · ' + escapeHTML(h.type) + '</span>';
}
function renderHoldingRateBadge(rate) {
  const rateStyle = !Number.isFinite(rate) || Math.abs(rate) < 0.005 ? "neutral" : gainClass(rate);
  const rateText = !Number.isFinite(rate) ? "—" : rateStyle === "neutral" ? "0.00%" : `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%`;
  const largeRateClass = Number.isFinite(rate) && Math.abs(rate) >= 1000 ? " is-large-value" : "";
  return `<span class="dashboard-holding-rate-badge${largeRateClass}" data-change="${rateStyle}">${rateText}</span>`;
}
function holdingRow(h, compact = false) {
  const value = valueOf(h), gain = hasValuation(h) ? value - costOf(h) : null, rate = gain !== null && costOf(h) ? gain / costOf(h) * 100 : null;
  const marketDate = h.type === "投資信託" ? formatFundDate(h.priceDate) : formatDateTime(h.priceTimestamp);
  const marketLabel = h.type === "投資信託" ? "基準日" : "価格日時";
  const quantityLabel = h.type === "投資信託" ? "保有口数" : "保有数量";
  return `<div class="holding-row"><div class="holding-identity"><div class="holding-name">${escapeHTML(h.name)}</div><div class="holding-meta">${renderHoldingMeta(h)}</div>${marketDate ? `<div class="holding-updated">${marketLabel} ${marketDate}</div>` : ""}</div><div class="holding-cell optional holding-current"><small>現在値</small><span class="money">${hasQuote(h) ? formatHoldingPrice(h) : "未取得"}</span></div><div class="holding-cell holding-pc-quantity"><small>保有数</small><span class="money">${formatHoldingQuantity(h)}</span></div><div class="holding-cell holding-value ${compact ? 'hide-mobile' : ''}"><small>評価額</small><span class="money">${value !== null ? formatJpyAmount(value) : "—"}</span></div><div class="holding-cell optional holding-gain" data-known="${gain !== null}"><small>評価損益</small><span class="gain ${gainClass(gain || 0)}">${gain !== null ? signed(gain) : "—"}</span></div><div class="holding-cell optional holding-rate"><small>評価損益率</small>${renderHoldingRateBadge(rate)}</div><div class="holding-cell holding-type ${compact ? 'hide-mobile' : ''}"><small>資産区分</small><span>${h.type}</span></div><button class="icon-button holding-menu" data-edit-holding="${h.id}" aria-label="編集">⋮</button><div class="holding-cell holding-quantity"><small>${quantityLabel}</small><span>${HoldingNumberRules.format(h.quantity) ?? "—"}</span></div></div>`;
}
function dashboardHoldingRow(h) {
  const value = valueOf(h), cost = costOf(h);
  const gain = hasValuation(h) ? value - cost : null;
  const rate = gain !== null && cost ? gain / cost * 100 : null;
  const symbol = displaySymbol(h.type, h.symbol);
  const mobileName = h.type === "投資信託" ? h.name || symbol : symbol || h.name;
  const gainStyle = gainClass(gain || 0);
  return `<div class="dashboard-holding"><div class="dashboard-holding-identity"><div class="dashboard-holding-name">${escapeHTML(h.name)}</div><div class="dashboard-holding-meta">${renderHoldingMeta(h)}</div></div><div class="dashboard-holding-mobile-name">${escapeHTML(mobileName)}</div><div class="dashboard-holding-current"><small>現在値</small><span>${hasQuote(h) ? formatHoldingPrice(h) : "未取得"}</span></div><div class="dashboard-holding-quantity"><small>保有数</small><span>${formatHoldingQuantity(h)}</span></div><div class="dashboard-holding-value"><small>評価額</small><span>${value !== null ? formatJpyAmount(value) : "—"}</span></div><div class="dashboard-holding-gain"><div class="dashboard-holding-gain-amount" data-known="${gain !== null}"><small>評価損益</small><span class="${gainStyle}">${gain !== null ? signed(gain) : "—"}</span></div><div class="dashboard-holding-gain-rate"><small>評価損益率</small>${renderHoldingRateBadge(rate)}</div></div></div>`;
}
function renderDashboardHoldings() { $("#dashboard-holdings").innerHTML = data.holdings.length ? `<div class="dashboard-holding-header"><span>銘柄名</span><span>評価損益</span><span>評価損益率</span></div>` + sortHoldingsForList(data.holdings).slice(0,5).map(({ holding }) => dashboardHoldingRow(holding)).join("") : `<div class="empty-state" style="height:100px">まだ保有資産がありません</div>`; }
function sortHoldingsForList(holdings) {
  const accountOrder = new Map(data.accounts.map((item, index) => [item.id, index]));
  const categories = data.accountCategories || [];
  const categoryOrder = new Map(categories.map((item, index) => [item.code, { sortOrder: item.sortOrder, index }]));
  const typeOrder = new Map(["米国株", "日本株", "投資信託"].map((type, index) => [type, index]));
  return holdings.map((holding, index) => {
    const symbol = normalizeStoredSymbol(holding.type, holding.symbol).toUpperCase();
    return { holding, index, symbol,
      categoryCode: holding.accountCategoryCode || "unassigned" };
  }).sort((a, b) => {
    const accountDifference = (accountOrder.get(a.holding.accountId) ?? data.accounts.length) -
      (accountOrder.get(b.holding.accountId) ?? data.accounts.length);
    if (accountDifference) return accountDifference;
    const accountIdDifference = a.holding.accountId.localeCompare(b.holding.accountId);
    if (accountIdDifference) return accountIdDifference;
    const aCategory = categoryOrder.get(a.categoryCode), bCategory = categoryOrder.get(b.categoryCode);
    const categoryDifference = (aCategory?.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (bCategory?.sortOrder ?? Number.MAX_SAFE_INTEGER);
    if (categoryDifference) return categoryDifference;
    const categoryIndexDifference = (aCategory?.index ?? categories.length) - (bCategory?.index ?? categories.length);
    if (categoryIndexDifference) return categoryIndexDifference;
    const categoryCodeDifference = a.categoryCode.localeCompare(b.categoryCode);
    if (categoryCodeDifference) return categoryCodeDifference;
    const typeDifference = (typeOrder.get(a.holding.type) ?? typeOrder.size) -
      (typeOrder.get(b.holding.type) ?? typeOrder.size);
    if (typeDifference) return typeDifference;
    const unknownTypeDifference = a.holding.type.localeCompare(b.holding.type);
    if (unknownTypeDifference) return unknownTypeDifference;
    if (!a.symbol) return b.symbol ? 1 : a.index - b.index;
    if (!b.symbol) return -1;
    return a.symbol.localeCompare(b.symbol, "en") || a.index - b.index;
  });
}
function renderHoldingsTable() {
  const accountFilter = $("#filter-account").value, typeFilter = $("#filter-type").value;
  const filtered = data.holdings.filter(holding =>
    (accountFilter === "all" || holding.accountId === accountFilter) &&
    (typeFilter === "all" || holding.type === typeFilter));
  const container = $("#holdings-table");
  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state" style="height:160px">「保有資産を追加」から最初の銘柄を登録してください</div>`;
    return;
  }
  const categoryLabels = new Map((data.accountCategories || []).map(category => [category.code, category.label]));
  let lastAccountId = null, lastCategoryCode = null;
  const rows = sortHoldingsForList(filtered).map(({ holding, categoryCode }) => {
    let headings = "";
    if (holding.accountId !== lastAccountId) {
      headings += `<h2 class="holdings-account-heading">${escapeHTML(account(holding.accountId)?.name || "—")}</h2>`;
      lastAccountId = holding.accountId;
      lastCategoryCode = null;
    }
    if (categoryCode !== lastCategoryCode) {
      headings += `<h3 class="holdings-category-heading">${escapeHTML(categoryLabels.get(categoryCode) || (categoryCode === "unassigned" ? "未設定" : categoryCode))}</h3>`;
      lastCategoryCode = categoryCode;
    }
    return headings + holdingRow(holding);
  }).join("");
  container.innerHTML = rows;
}
function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("ja-JP", {timeZone:"Asia/Tokyo",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value;
  return part("month") && part("day") && part("hour") && part("minute") ? `${part("month")}/${part("day")} ${part("hour")}:${part("minute")}` : "";
}
function buildSnapshotSeries(response, selectedAccountId = "total") {
  if (!Array.isArray(response?.snapshots)) return [];
  return response.snapshots.map(snapshot => {
    const date = typeof snapshot?.date === "string" ? snapshot.date : "";
    const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const label = dateParts ? `${Number(dateParts[2])}/${Number(dateParts[3])}` : "";
    const tooltipDate = dateParts ? `${dateParts[1]}/${Number(dateParts[2])}/${Number(dateParts[3])}` : "";
    const selectedAccount = selectedAccountId === "total"
      ? null
      : (Array.isArray(snapshot?.accounts) ? snapshot.accounts.find(account => account.accountId === selectedAccountId) : null);
    const rawValue = selectedAccountId === "total" ? snapshot?.totalValueJpy : selectedAccount?.valueJpy;
    const valueJpy = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : null;

    return { date, label, tooltipDate, valueJpy, isComplete: snapshot?.isComplete === true };
  });
}
function shiftSnapshotDate(date, days) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!parts) return null;
  const shifted = new Date(0);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]) + days);
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}
function shiftSnapshotDateByMonths(date, months) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!parts || !Number.isInteger(months)) return null;
  const year = Number(parts[1]);
  const monthIndex = Number(parts[2]) - 1;
  const shiftedMonth = year * 12 + monthIndex + months;
  const targetYear = Math.floor(shiftedMonth / 12);
  const targetMonthIndex = ((shiftedMonth % 12) + 12) % 12;
  const monthEnd = new Date(0);
  monthEnd.setUTCHours(0, 0, 0, 0);
  monthEnd.setUTCFullYear(targetYear, targetMonthIndex + 1, 0);
  const targetDay = Math.min(Number(parts[3]), monthEnd.getUTCDate());
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonthIndex + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}
function filterSnapshotSeriesByRange(series, range = "1m") {
  const ordered = Array.isArray(series)
    ? series.filter(point => /^\d{4}-\d{2}-\d{2}$/.test(point.date)).slice().sort((a, b) => a.date.localeCompare(b.date))
    : [];
  const months = { "1m": 1, "3m": 3, "6m": 6, "1y": 12 }[range];
  if ((!months && range !== "ytd") || !ordered.length) return ordered;
  const latestDate = ordered[ordered.length - 1].date;
  const cutoff = range === "ytd" ? `${latestDate.slice(0, 4)}-01-01` : shiftSnapshotDateByMonths(latestDate, -months);
  return cutoff ? ordered.filter(point => point.date >= cutoff && point.date <= latestDate) : ordered;
}
function calculateSnapshotChange(series) {
  const valued = Array.isArray(series) ? series.filter(point => Number.isFinite(point.valueJpy)) : [];
  if (valued.length < 2) return { valueJpy: null, ratePercent: null };
  const previous = valued[valued.length - 2];
  const latest = valued[valued.length - 1];
  const valueJpy = latest.valueJpy - previous.valueJpy;
  return { valueJpy, ratePercent: previous.valueJpy > 0 ? valueJpy / previous.valueJpy * 100 : null };
}
function calculatePeriodChange(series) {
  const valued = Array.isArray(series) ? series.filter(point => Number.isFinite(point.valueJpy)) : [];
  if (valued.length < 2) return { valueJpy: null, ratePercent: null };
  const first = valued[0].valueJpy;
  const change = valued[valued.length - 1].valueJpy - first;
  return { valueJpy: change, ratePercent: first > 0 ? change / first * 100 : null };
}
function formatSnapshotRate(rate) {
  return Number.isFinite(rate) ? `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%` : "—";
}
function formatSnapshotAxisValue(value) {
  const absolute = Math.abs(value);
  if (absolute >= 100000000) return `${number.format(value / 100000000)}億`;
  if (absolute >= 10000) return `${number.format(value / 10000)}万`;
  return number.format(value);
}
function niceSnapshotStep(value) {
  if (!(value > 0) || !Number.isFinite(value)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
}
function buildSnapshotSegments(coordinates) {
  const segments = [];
  let segment = [];
  for (const coordinate of coordinates) {
    if (coordinate) segment.push(coordinate);
    else if (segment.length) { segments.push(segment); segment = []; }
  }
  if (segment.length) segments.push(segment);
  return segments;
}
function renderTotalValueSparkline(series) {
  const chart = $("#total-value-sparkline");
  const pathGroup = $("#total-value-sparkline-path");
  setSvgHidden(chart, true);
  pathGroup.replaceChildren();
  const latestDate = series[series.length - 1]?.date;
  const cutoff = shiftSnapshotDate(latestDate, -29);
  const recent = cutoff ? series.filter(point => point.date >= cutoff && point.date <= latestDate) : series.slice(-30);
  const valid = recent.filter(point => point.valueJpy !== null);
  if (valid.length < 2) return;
  const min = Math.min(...valid.map(point => point.valueJpy));
  const max = Math.max(...valid.map(point => point.valueJpy));
  const width = 320;
  const height = 64;
  const padding = 7;
  const coordinates = recent.map((point, index) => {
    if (point.valueJpy === null) return null;
    const x = recent.length < 2 ? width / 2 : index / (recent.length - 1) * width;
    const y = max === min ? height / 2 : padding + (max - point.valueJpy) / (max - min) * (height - padding * 2);
    return { x, y };
  });
  const paths = buildSnapshotSegments(coordinates).filter(segment => segment.length > 1).map(segment =>
    segment.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")
  );
  if (!paths.length) return;
  pathGroup.innerHTML = paths.map(path => `<path class="metric-sparkline-line" d="${path}" />`).join("");
  setSvgHidden(chart, false);
}
function setSvgHidden(chart, hidden) {
  chart.hidden = hidden;
  chart.toggleAttribute?.("hidden", hidden);
}
function drawSnapshotChart(series, prefix, range, { interactive = false } = {}) {
  const chart = $(`#${prefix}-chart`);
  const grid = $(`#${prefix}-grid`);
  const area = $(`#${prefix}-area`);
  const lines = $(`#${prefix}-lines`);
  const markers = $(`#${prefix}-points`);
  const xLabels = $(`#${prefix}-x-labels`);
  const yLabels = $(`#${prefix}-y-labels`);
  for (const group of [grid, area, lines, markers, xLabels, yLabels]) group.replaceChildren();

  const values = series.filter(point => Number.isFinite(point.valueJpy)).map(point => point.valueJpy);
  if (!values.length) {
    setSvgHidden(chart, true);
    return false;
  }

  setSvgHidden(chart, false);
  const chartBounds = chart.getBoundingClientRect ? chart.getBoundingClientRect() : null;
  const measuredWidth = chartBounds?.width || 0;
  const width = Number.isFinite(measuredWidth) && measuredWidth > 0 ? measuredWidth : 800;
  const measuredHeight = chartBounds?.height || 0;
  const height = Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : interactive ? 300 : 100;
  const plotLeft = Math.max(58, width * .095);
  const plotRight = width - 14;
  const plotTop = Math.max(10, height * .08);
  const plotBottom = height - (interactive ? 28 : Math.max(22, height * .22));
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = plotBottom - plotTop;
  chart.setAttribute?.("viewBox", `0 0 ${width.toFixed(1)} ${height}`);

  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const padding = Math.max(Math.abs(min) * .02, 1);
    min -= padding;
    max += padding;
  }
  const step = niceSnapshotStep((max - min) / 4);
  const axisMin = Math.floor(min / step) * step;
  const axisMax = Math.ceil(max / step) * step;
  const tickValues = [];
  for (let tick = axisMin, count = 0; tick <= axisMax + step * .001 && count < 8; tick += step, count++) tickValues.push(tick);
  grid.innerHTML = tickValues.map(tick => {
    const y = plotTop + (axisMax - tick) / (axisMax - axisMin || 1) * plotHeight;
    return `<line class="asset-trend-grid-line" x1="${plotLeft.toFixed(1)}" y1="${y.toFixed(1)}" x2="${plotRight.toFixed(1)}" y2="${y.toFixed(1)}" />`;
  }).join("");
  yLabels.innerHTML = tickValues.map(tick => {
    const y = plotTop + (axisMax - tick) / (axisMax - axisMin || 1) * plotHeight + 4;
    return `<text class="asset-trend-axis-label asset-trend-y-label" x="${(plotLeft - 9).toFixed(1)}" y="${y.toFixed(1)}">${formatSnapshotAxisValue(tick)}</text>`;
  }).join("");

  const coordinates = series.map((point, index) => {
    if (!Number.isFinite(point.valueJpy)) return null;
    const x = plotLeft + (series.length < 2 ? plotWidth / 2 : index / (series.length - 1) * plotWidth);
    const y = plotTop + (axisMax - point.valueJpy) / (axisMax - axisMin || 1) * plotHeight;
    return { point, x, y };
  });
  const segments = buildSnapshotSegments(coordinates);
  const linePaths = segments.filter(segment => segment.length > 1).map(segment =>
    segment.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")
  );
  const areaPaths = segments.filter(segment => segment.length > 1).map(segment => {
    const line = segment.map(point => `L${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
    return `M${segment[0].x.toFixed(1)},${plotBottom.toFixed(1)} ${line} L${segment[segment.length - 1].x.toFixed(1)},${plotBottom.toFixed(1)} Z`;
  });
  area.innerHTML = areaPaths.map(path => `<path class="asset-trend-area" d="${path}" />`).join("");
  lines.innerHTML = linePaths.map(path => `<path class="asset-trend-line" d="${path}" />`).join("");
  markers.innerHTML = coordinates.filter(Boolean).map(({ point, x, y }) => {
    const amount = formatJpyAmount(point.valueJpy);
    const marker = `<circle class="asset-trend-point" data-date="${point.date}" data-complete="${point.isComplete}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${interactive ? 4 : 3}"><title>${point.tooltipDate}・${amount}${point.isComplete ? "" : "・不完全なスナップショット"}</title></circle>`;
    return interactive ? `${marker}<circle class="trend-detail-hit" data-trend-point data-date="${point.tooltipDate}" data-value="${amount}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" tabindex="0" aria-label="${point.tooltipDate}・${amount}" />` : marker;
  }).join("");

  const distinctYears = new Set(series.map(point => point.date.slice(0, 4)));
  const xLabelCount = Math.min(series.length, 5);
  const xIndices = xLabelCount < 2 ? [0] : Array.from({ length: xLabelCount }, (_, index) => Math.round(index * (series.length - 1) / (xLabelCount - 1)));
  xLabels.innerHTML = [...new Set(xIndices)].map((index, labelIndex, indices) => {
    const point = series[index];
    const x = plotLeft + (series.length < 2 ? plotWidth / 2 : index / (series.length - 1) * plotWidth);
    const label = range === "all" && distinctYears.size > 1 ? point.date.slice(0, 4) : point.label;
    const anchor = labelIndex === 0 ? "start" : labelIndex === indices.length - 1 ? "end" : "middle";
    return label ? `<text class="asset-trend-axis-label asset-trend-x-label" x="${x.toFixed(1)}" y="${(height - 4).toFixed(1)}" text-anchor="${anchor}">${escapeHTML(label)}</text>` : "";
  }).join("");
  return true;
}
function renderAssetTrend(response) {
  const allSeries = filterSnapshotSeriesByRange(buildSnapshotSeries(response, "total"), "all");
  const series = filterSnapshotSeriesByRange(allSeries, selectedAssetTrendRange);
  renderTotalValueSparkline(allSeries);
  const hasValues = drawSnapshotChart(series, "asset-trend", selectedAssetTrendRange);
  const message = $("#asset-trend-message");
  message.hidden = hasValues;
  if (!hasValues) message.textContent = allSeries.length
    ? series.length ? "選択した期間に評価額データはありません" : "選択した期間のスナップショットはありません"
    : "価格更新後に資産推移を表示します";
}
function renderTrendDetailAccountOptions() {
  const selector = $("#trend-detail-account");
  if (selectedTrendDetailAccountId !== "total" && !data.accounts.some(account => account.id === selectedTrendDetailAccountId)) selectedTrendDetailAccountId = "total";
  selector.innerHTML = `<option value="total">総資産</option>${data.accounts.map(account => `<option value="${escapeHTML(account.id)}">${escapeHTML(account.name)}</option>`).join("")}`;
  selector.value = selectedTrendDetailAccountId;
}
function renderAssetTrendDetail(response) {
  const allSeries = filterSnapshotSeriesByRange(buildSnapshotSeries(response, selectedTrendDetailAccountId), "all");
  const series = filterSnapshotSeriesByRange(allSeries, selectedTrendDetailRange);
  const valued = series.filter(point => Number.isFinite(point.valueJpy));
  const latest = [...allSeries].reverse().find(point => Number.isFinite(point.valueJpy));
  const previous = calculateSnapshotChange(allSeries);
  const periodChange = calculatePeriodChange(series);
  $("#trend-detail-target-label").textContent = selectedTrendDetailAccountId === "total" ? "総資産" : data.accounts.find(account => account.id === selectedTrendDetailAccountId)?.name || "総資産";
  $("#trend-detail-current").textContent = latest ? formatJpyAmount(latest.valueJpy) : "—";
  const previousAmount = $("#trend-detail-previous-amount");
  previousAmount.textContent = signed(previous.valueJpy);
  previousAmount.className = Number.isFinite(previous.valueJpy) ? gainClass(previous.valueJpy) : "";
  const previousRate = $("#trend-detail-previous-rate");
  previousRate.textContent = formatSnapshotRate(previous.ratePercent);
  previousRate.className = Number.isFinite(previous.ratePercent) ? gainClass(previous.ratePercent) : "";

  const first = valued[0];
  const last = valued[valued.length - 1];
  const spansYears = first && last && first.date.slice(0, 4) !== last.date.slice(0, 4);
  const dateLabel = point => point ? spansYears ? point.tooltipDate : point.label : "";
  $("#trend-detail-period").textContent = first ? first === last ? dateLabel(first) : `${dateLabel(first)} → ${dateLabel(last)}` : "—";
  const changeAmount = $("#trend-detail-change-amount");
  changeAmount.textContent = signed(periodChange.valueJpy);
  changeAmount.className = Number.isFinite(periodChange.valueJpy) ? gainClass(periodChange.valueJpy) : "";
  const changeRate = $("#trend-detail-change-rate");
  changeRate.textContent = formatSnapshotRate(periodChange.ratePercent);
  changeRate.className = Number.isFinite(periodChange.ratePercent) ? gainClass(periodChange.ratePercent) : "";

  $("#trend-detail-tooltip").hidden = true;
  const hasValues = drawSnapshotChart(series, "trend-detail", selectedTrendDetailRange, { interactive: true });
  const message = $("#trend-detail-message");
  message.hidden = hasValues;
  if (!hasValues) message.textContent = !response ? "資産推移を読み込めませんでした"
    : !allSeries.length ? "価格更新後に資産推移を表示します"
    : !series.length ? "選択した期間のスナップショットはありません"
    : "選択した対象の評価額データはありません";
}
async function loadAssetTrend({ refresh = false } = {}) {
  if (snapshotFetchPromise) await snapshotFetchPromise;
  if (!refresh && snapshotResponseCache) {
    renderAssetTrend(snapshotResponseCache);
    if ($("#trend-view").classList.contains("active")) renderAssetTrendDetail(snapshotResponseCache);
    return snapshotResponseCache;
  }
  snapshotFetchPromise = (async () => {
    try {
      const response = await fetch("/api/v1/snapshots?from=0001-01-01", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.snapshots)) throw new Error(payload.error || "資産推移を取得できませんでした");
      snapshotResponseCache = payload;
      renderAssetTrend(payload);
      if ($("#trend-view").classList.contains("active")) renderAssetTrendDetail(payload);
      return payload;
    } catch {
      if (snapshotResponseCache) renderAssetTrend(snapshotResponseCache);
      else {
        setSvgHidden($("#asset-trend-chart"), true);
        $("#asset-trend-message").hidden = false;
        $("#asset-trend-message").textContent = "資産推移を読み込めませんでした";
      }
      if ($("#trend-view").classList.contains("active")) renderAssetTrendDetail(snapshotResponseCache);
      return null;
    } finally {
      snapshotFetchPromise = null;
    }
  })();
  return snapshotFetchPromise;
}
function formatFundDate(value) { return typeof value === "string" && /^\d{1,2}\/\d{1,2}$/.test(value) ? value : ""; }
function renderAccounts() {
  $("#accounts-list").innerHTML = data.accounts.map(a => { const list=data.holdings.filter(h=>h.accountId===a.id), valued=list.filter(hasValuation), value=valued.reduce((n,h)=>n+valueOf(h),0); return `<article class="account-card"><div class="account-card-top"><div><h3>${escapeHTML(a.name)}</h3><p class="account-note">${escapeHTML(a.note || "メモなし")}</p></div><button class="icon-button" data-edit-account="${a.id}">⋮</button></div><p class="account-card-value">${valued.length ? formatJpyAmount(value) : "—"}</p><p class="account-card-count">${list.length} 銘柄を保有</p></article>`; }).join("");
}
function renderAccountOptions() { const current = $("#filter-account").value; $("#filter-account").innerHTML = `<option value="all">すべての口座</option>${data.accounts.map(a=>`<option value="${a.id}">${escapeHTML(a.name)}</option>`).join("")}`; $("#filter-account").value = current; }
function escapeHTML(s) { const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }
function formatHoldingNumericInput(value) { return HoldingNumberRules.format(value); }
function formatHoldingNumericField(field) {
  const formatted = formatHoldingNumericInput(field.value);
  if (formatted !== null) field.value = formatted;
}
function isIdecoCategory(categoryCode) { return categoryCode === "ideco"; }
function normalizeIdecoAcquisitionAmount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}
let holdingEditState = null;
let holdingLookupRequest = 0;
let holdingFieldErrors = { quantity: "", cost: "", form: "" };
function renderHoldingInputErrors() {
  const messages = [holdingFieldErrors.form, holdingFieldErrors.quantity, holdingFieldErrors.cost].filter(Boolean);
  const element = $("#holding-input-error");
  element.textContent = messages.join("\n");
  element.hidden = messages.length === 0;
}
function setHoldingFieldError(field, message) {
  holdingFieldErrors[field] = message || "";
  const selector = field === "quantity" ? "#holding-quantity" : "#holding-cost";
  if (message) $(selector).dataset.invalid = "true";
  else delete $(selector).dataset.invalid;
  renderHoldingInputErrors();
}
function clearHoldingFieldError(field) { setHoldingFieldError(field, ""); }
function holdingFormContext() {
  const type = $("#holding-type").value;
  return { type, currency: $("#holding-currency").value,
    accountCategoryCode: $("#holding-account-category").value,
    symbol: normalizeStoredSymbol(type, $("#holding-symbol").value.toUpperCase()) };
}
function showHoldingInputError(message, invalidField = null) {
  if (invalidField) {
    const field = invalidField === "#holding-quantity" ? "quantity" : "cost";
    setHoldingFieldError(field, message || "");
    holdingFieldErrors.form = "";
  } else if (message) {
    holdingFieldErrors.form = message;
  } else {
    holdingFieldErrors = { quantity: "", cost: "", form: "" };
    delete $("#holding-quantity").dataset.invalid;
    delete $("#holding-cost").dataset.invalid;
  }
  renderHoldingInputErrors();
}
function clearHoldingInput(selector) {
  const field = $(selector);
  if (field.value.trim() !== "") field.dataset.cleared = "true";
  field.value = "";
}
function clearHoldingNumbers(message, costOnly = false) {
  if (!costOnly) clearHoldingInput("#holding-quantity");
  clearHoldingInput("#holding-cost");
  if (!costOnly) clearHoldingFieldError("quantity");
  clearHoldingFieldError("cost");
  if (holdingEditState) {
    if (!costOnly) holdingEditState.originalQuantity = undefined;
    holdingEditState.originalCost = undefined;
  }
  showHoldingInputError(message);
  refreshIdecoAcquisitionUnitPreview();
}
function validateHoldingField(field) {
  const context = holdingFormContext();
  const original = field === "quantity" ? holdingEditState?.originalQuantity : holdingEditState?.originalCost;
  const unchanged = HoldingNumberRules.sameMeaning(holdingEditState?.original, context, field) &&
    !(field === "cost" && isIdecoCategory(context.accountCategoryCode)) ? original : undefined;
  return HoldingNumberRules.validate($(field === "quantity" ? "#holding-quantity" : "#holding-cost").value, context, field, unchanged);
}
function rememberHoldingClassification() {
  const context = holdingFormContext();
  if (holdingEditState) holdingEditState.classification = context;
}
function handleHoldingClassificationChange() {
  const previous = holdingEditState?.classification;
  // iDeCo still fixes the asset type to mutual funds.
  updateHoldingFormLabels();
  const current = holdingFormContext();
  if (previous && (previous.type !== current.type || isIdecoCategory(previous.accountCategoryCode) !== isIdecoCategory(current.accountCategoryCode))) {
    clearHoldingNumbers("資産区分・口座区分が変更されたため、保有数量と取得値をクリアしました。\n新しい区分の値を入力してください。");
  } else if (previous && previous.currency !== current.currency) {
    clearHoldingNumbers("通貨が変更されたため、取得値をクリアしました。\n新しい通貨の値を入力してください。", true);
  }
  rememberHoldingClassification();
}
function handleHoldingAccountCategoryChange() { handleHoldingClassificationChange(); }
function sameHoldingIdentity(left, right) {
  return Boolean(left && right && left.type === right.type && left.symbol === right.symbol);
}
function confirmHoldingSymbolChange(confirmedIdentity = holdingFormContext()) {
  if (!holdingEditState) return false;
  const identity = { type: confirmedIdentity.type, symbol: confirmedIdentity.symbol };
  if (!holdingEditState.confirmedIdentity) {
    holdingEditState.confirmedIdentity = identity;
    return false;
  }
  if (sameHoldingIdentity(holdingEditState.confirmedIdentity, identity)) return false;
  clearHoldingInput("#holding-name");
  clearHoldingNumbers("銘柄が変更されたため、銘柄名・保有数量・取得値をクリアしました。\n新しい銘柄の値を入力してください。");
  holdingEditState.confirmedIdentity = identity;
  return true;
}
function calculateIdecoAcquisitionUnitCost(quantity, acquisitionAmount) {
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(acquisitionAmount) || acquisitionAmount < 0) return null;
  const unitCost = acquisitionAmount / quantity * 10000;
  return Number.isFinite(unitCost) ? unitCost : null;
}
function refreshIdecoAcquisitionUnitPreview() {
  const preview = $("#holding-cost-calculated");
  const ideco = isIdecoCategory($("#holding-account-category").value);
  preview.hidden = !ideco;
  if (!ideco) return;
  const quantity = validateHoldingField("quantity").value ?? null;
  const acquisitionAmount = validateHoldingField("cost").value ?? null;
  const unitCost = quantity === null ? null : calculateIdecoAcquisitionUnitCost(quantity, acquisitionAmount);
  const formatted = unitCost === null ? null : new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(unitCost);
  preview.textContent = `取得単価（自動計算）：${formatted === null ? "—" : `${formatted}円`}`;
}
function updateHoldingFormLabels() {
  const type = $("#holding-type").value;
  const ideco = isIdecoCategory($("#holding-account-category").value);
  if (ideco) $("#holding-type").value = "投資信託";
  $("#holding-type").disabled = ideco;
  const isFund = ideco || type === "投資信託";
  $("#quantity-label").textContent = isFund ? "保有口数" : "保有数量";
  $("#cost-label").textContent = ideco ? "取得金額（円）" : isFund ? "取得基準価額（1万口あたり）" : "取得単価";
  $("#holding-quantity").placeholder = isFund ? "例：150000" : "例：100";
  $("#holding-cost").placeholder = ideco ? "例：273948" : isFund ? "例：10000" : "例：2500";
  $("#holding-symbol").placeholder = isFund ? "例：9I311181" : type === "日本株" ? "例：7203 / 563A" : "例：AAPL";
  $("#holding-symbol-label").textContent = isFund ? "投信コード" : "Yahoo Finance ティッカー";
  $("#holding-symbol-help").textContent = isFund ? "半角英数字8文字。銘柄名・基準価額を取得します。" : "このティッカーで価格を自動取得します";
  $("#fund-unit-note").hidden = !isFund;
  refreshIdecoAcquisitionUnitPreview();
}
function openHolding(id) {
  const holding = data.holdings.find(item => item.id === id);
  // A late response from a previous dialog session must not affect this one.
  holdingLookupRequest++;
  $("#holding-symbol").disabled = false;
  $("#lookup-name").disabled = false;
  holdingEditState = null;
  holdingFieldErrors = { quantity: "", cost: "", form: "" };
  $("#holding-form").reset();
  ["#holding-name", "#holding-quantity", "#holding-cost"].forEach(selector => {
    delete $(selector).dataset.cleared;
  });
  $("#holding-id").value = id || "";
  $("#holding-dialog-title").textContent = holding ? "保有資産を編集" : "保有資産を追加";
  $("#holding-form-kicker").textContent = holding ? "EDIT HOLDING" : "NEW HOLDING";
  $("#holding-account").innerHTML = data.accounts.map(account => `<option value="${account.id}">${escapeHTML(account.name)}</option>`).join("");
  const categorySelect = $("#holding-account-category");
  categorySelect.replaceChildren(...(data.accountCategories || []).map(category => new Option(category.label, category.code)));
  if (!categorySelect.options.length) categorySelect.add(new Option("口座区分を取得できません", ""));
  categorySelect.value = holding?.accountCategoryCode || "unassigned";
  if (holding) {
    $("#holding-account").value = holding.accountId;
    $("#holding-type").value = holding.type;
    $("#holding-currency").value = holding.currency;
    $("#holding-name").value = holding.name;
    $("#holding-symbol").value = displaySymbol(holding.type, holding.symbol);
    $("#holding-quantity").value = HoldingNumberRules.format(holding.quantity) ?? "";
    const enteredCost = isIdecoCategory(categorySelect.value)
      ? normalizeIdecoAcquisitionAmount(holding.cost * holding.quantity / 10000) : holding.cost;
    $("#holding-cost").value = HoldingNumberRules.format(enteredCost) ?? "";
  }
  $("#name-lookup-status").textContent = "";
  showHoldingInputError("");
  updateHoldingFormLabels();
  holdingEditState = {
    original: holding ? { ...holding, symbol: normalizeStoredSymbol(holding.type, holding.symbol.toUpperCase()) } : null,
    originalQuantity: holding?.quantity, originalCost: holding?.cost,
    confirmedIdentity: holding ? { type: holding.type, symbol: normalizeStoredSymbol(holding.type, holding.symbol.toUpperCase()) } : null,
    classification: holdingFormContext()
  };
  refreshIdecoAcquisitionUnitPreview();
  $("#holding-dialog").showModal();
}
function openAccount(id) { const a=data.accounts.find(x=>x.id===id); $("#account-form").reset(); $("#account-id").value=id||""; $("#account-dialog-title").textContent=a?"証券口座を編集":"証券口座を追加"; $("#account-form-kicker").textContent=a?"EDIT ACCOUNT":"NEW ACCOUNT"; if(a){$("#account-name").value=a.name;$("#account-note").value=a.note} $("#account-dialog").showModal(); }
async function lookupHoldingName() {
  const button = $("#lookup-name"), status = $("#name-lookup-status"), field = $("#holding-symbol");
  if (button.disabled) return;
  const type = $("#holding-type").value;
  field.value = field.value.toUpperCase();
  const symbol = normalizeStoredSymbol(type, field.value);
  if (!symbol) { status.textContent = "先に銘柄コードを入力してください"; return; }
  const request = ++holdingLookupRequest;
  button.disabled = true; field.disabled = true; status.textContent = "取得中…";
  const editId = $("#holding-id").value;
  const isCurrent = () => request === holdingLookupRequest && $("#holding-dialog").open &&
    editId === $("#holding-id").value && type === $("#holding-type").value && symbol === holdingFormContext().symbol;
  try {
    const res = type === "投資信託"
      ? await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}&type=${encodeURIComponent(type)}`)
      : await fetch(`/api/name?symbol=${encodeURIComponent(symbol)}&type=${encodeURIComponent(type)}`);
    const result = await res.json();
    if (!isCurrent()) return;
    if (!res.ok) throw new Error(result.error || "銘柄情報を取得できませんでした");
    if (!result.name) throw new Error("銘柄名を取得できませんでした。銘柄名を手入力してください。");
    confirmHoldingSymbolChange({ type, symbol });
    $("#holding-name").value = result.name;
    delete $("#holding-name").dataset.cleared;
    status.textContent = "銘柄名を入力しました。必要に応じて修正できます。";
  } catch (error) {
    if (isCurrent()) status.textContent = `${error.message} 銘柄名は手入力できます。`;
  } finally {
    if (request === holdingLookupRequest) {
      button.disabled = false; field.disabled = false;
      if (!isCurrent()) status.textContent = "入力内容が変わったため、取得結果を反映しませんでした。";
    }
  }
}
async function updateQuote(h) {
  h.quoteAttemptedAt = Date.now();
  try {
    const symbol = encodeURIComponent(normalizeStoredSymbol(h.type, h.symbol).toUpperCase());
    const type = encodeURIComponent(h.type || "");
    const res = await fetch(`/api/quote?symbol=${symbol}&type=${type}`);
    if (!res.ok) { const error = await res.json().catch(() => ({})); throw new Error(error.error || "取得できませんでした"); }
    const quote = await res.json(); if(!Number.isFinite(quote.price) || quote.price < 0) throw new Error("価格がありません");
    h.price = quote.price;
    h.previousClose = Number.isFinite(quote.previousClose) && quote.previousClose > 0 ? quote.previousClose : null;
    h.priceTimestamp = Number.isFinite(quote.priceTimestamp) && quote.priceTimestamp > 0 ? quote.priceTimestamp : null;
    h.priceDate = typeof quote.priceDate === "string" && /^\d{1,2}\/\d{1,2}$/.test(quote.priceDate) ? quote.priceDate : null;
    h.quoteStatus = "success";
  } catch (error) {
    h.quoteStatus = "failed";
    throw error;
  }
}
async function updateAll() {
  if (!serverConnected || !serverInitialized) {
    showSyncNotice("共通サーバーに接続して初回移行を完了すると、価格を更新できます。", { migration: serverConnected && !serverInitialized, retry: !serverConnected });
    return;
  }
  const previousData=cloneData(data), button=$("#refresh-all");button.disabled=true;button.innerHTML="⌛ <span>更新中…</span>";const errors=[];
  let fxQuoteFailed = false;
  try {
    const fxQuote = {symbol:"JPY=X", currency:"JPY"};
    await updateQuote(fxQuote);
    fxRate = fxQuote.price;
    data.usdJpyRate = fxRate;
    data.usdJpyTimestamp = Number.isFinite(fxQuote.priceTimestamp) && fxQuote.priceTimestamp > 0 ? fxQuote.priceTimestamp : null;
  } catch { fxQuoteFailed = true; }
  for(const h of data.holdings){try{await updateQuote(h)}catch(error){errors.push(`${h.name}（${displaySymbol(h.type, h.symbol)}）`)}}
  data.lastQuoteFetchedAt=Date.now();
  try {
    await persistState(previousData, { quoteFailureCount: errors.length + Number(fxQuoteFailed) });
    await Promise.all([loadAssetTrend({ refresh: true }), loadMarketWeather()]);
    if(errors.length) $("#quote-status").textContent=`価格を取得できませんでした：${errors.join("、")}。投信は半角英数字8文字の投信コードを入力してください。`;
  } catch { /* persistState restores the last confirmed state and shows the error. */ }
  finally {button.disabled=false;button.innerHTML="↻ <span>価格を更新</span>";}
}
function renderVersionHistoryList(container) {
  container.replaceChildren();
  if (!versionHistoryEntries.length) {
    const empty = document.createElement("p");
    empty.className = "version-history-empty";
    empty.textContent = "バージョン履歴を読み込めませんでした。";
    container.append(empty);
    return;
  }
  for (const entry of versionHistoryEntries) {
    const article = document.createElement("article");
    article.className = "version-history-entry";
    const heading = document.createElement("div");
    heading.className = "version-history-entry-heading";
    const version = document.createElement("strong");
    version.className = "version-history-number";
    version.textContent = entry.version;
    const date = document.createElement("time");
    date.dateTime = entry.date.replaceAll("/", "-");
    date.textContent = entry.date;
    heading.append(version, date);
    const commits = document.createElement("div");
    commits.className = "version-history-commits";
    for (const commit of entry.commits) {
      const commitSection = document.createElement("section");
      commitSection.className = "version-history-commit";
      const message = document.createElement("h3");
      message.className = "version-history-commit-title";
      message.textContent = commit.message;
      const changes = document.createElement("ul");
      changes.className = "version-history-changes";
      for (const change of commit.changes) {
        const item = document.createElement("li");
        item.textContent = change;
        changes.append(item);
      }
      commitSection.append(message, changes);
      commits.append(commitSection);
    }
    article.append(heading, commits);
    container.append(article);
  }
}

function renderVersionHistory() {
  renderVersionHistoryList($("#version-history-dialog-list"));
  renderVersionHistoryList($("#version-history-mobile-list"));
  const currentVersion = versionHistoryEntries[0]?.version || "—";
  const currentVersionLabel = /^\d+(?:\.\d+)+$/.test(currentVersion) ? `v${currentVersion}` : currentVersion;
  document.querySelectorAll("[data-open-version-history]").forEach(button => {
    button.textContent = currentVersionLabel;
    button.setAttribute("aria-label", `バージョン ${currentVersionLabel}、バージョン履歴を開く`);
    button.title = "バージョン履歴を開く";
  });
}

async function loadVersionHistory() {
  try {
    const response = await fetch("/assets/version-history.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`version history fetch failed: ${response.status}`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error("version history must be an array");
    versionHistoryEntries = entries
      .filter(entry => entry && typeof entry.version === "string" &&
        typeof entry.date === "string" && /^\d{4}\/\d{2}\/\d{2}$/.test(entry.date) &&
        Array.isArray(entry.commits) && entry.commits.every(commit => commit && typeof commit.message === "string" &&
          Array.isArray(commit.changes) && commit.changes.every(change => typeof change === "string")))
      .sort((a, b) => b.date.localeCompare(a.date) || b.version.localeCompare(a.version, "ja", { numeric: true }));
  } catch (error) {
    console.error("バージョン履歴を読み込めませんでした。", error);
    versionHistoryEntries = [];
  }
  renderVersionHistory();
}

function openVersionHistory() {
  if (window.matchMedia("(max-width: 600px)").matches) {
    showAppView("version-history");
    return;
  }
  const dialog = $("#version-history-dialog");
  if (!dialog.open) dialog.showModal();
}

function showAppView(viewName) {
  const view = $(`#${viewName}-view`);
  if (!view) return;
  const selectedNavView = ["heatmap", "trend", "version-history"].includes(viewName) ? "dashboard" : viewName;
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === selectedNavView));
  document.querySelectorAll(".view").forEach(item => item.classList.toggle("active", item === view));
  $("#page-title").textContent = {
    dashboard: "資産の全体像", holdings: "保有資産", accounts: "証券口座", heatmap: "資産ヒートマップ", trend: "資産推移", goal: "資産目標シミュレーション", "version-history": "バージョン履歴"
  }[viewName];
  if (viewName === "goal") {
    const currentAssetsInput = $("#goal-current-assets");
    if (!currentAssetsInput.dataset.userEdited) currentAssetsInput.value = jpyNumber.format(Math.round(getCurrentTotalAssets()));
  }
  if (viewName === "dashboard" && snapshotResponseCache) renderAssetTrend(snapshotResponseCache);
  if (viewName === "trend") {
    renderTrendDetailAccountOptions();
    if (snapshotResponseCache) renderAssetTrendDetail(snapshotResponseCache);
    else void loadAssetTrend();
  }
  if (viewName === "heatmap" || viewName === "trend" || viewName === "goal" || viewName === "version-history") window.scrollTo(0, 0);
}

function showTrendPointTooltip(point) {
  if (!point) return;
  const tooltip = $("#trend-detail-tooltip");
  tooltip.textContent = `${point.dataset.date}\n${point.dataset.value}`;
  tooltip.hidden = false;
}

document.addEventListener("click", e => {
  const goalRate = e.target.closest("[data-goal-rate]");
  if (goalRate) {
    $("#goal-annual-return").value = goalRate.dataset.goalRate;
    $("#goal-error").hidden = true;
  }
  const trendRange = e.target.closest("[data-trend-range]");
  if (trendRange) {
    selectedAssetTrendRange = trendRange.dataset.trendRange;
    document.querySelectorAll("[data-trend-range]").forEach(button => {
      const isActive = button === trendRange;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
    if (snapshotResponseCache) renderAssetTrend(snapshotResponseCache);
  }
  const detailTrendRange = e.target.closest("[data-detail-trend-range]");
  if (detailTrendRange) {
    selectedTrendDetailRange = detailTrendRange.dataset.detailTrendRange;
    document.querySelectorAll("[data-detail-trend-range]").forEach(button => {
      const isActive = button === detailTrendRange;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
    if (snapshotResponseCache) renderAssetTrendDetail(snapshotResponseCache);
  }
  const nav=e.target.closest(".nav-item");
  if(nav)showAppView(nav.dataset.view);
  if(e.target.closest("[data-open-version-history]")) openVersionHistory();
  const heatmapDetails=e.target.closest("[data-heatmap-details]");if(heatmapDetails)showAppView("heatmap");
  const trendDetails=e.target.closest("[data-trend-details]");if(trendDetails)showAppView("trend");
  const go=e.target.closest("[data-go]");if(go)document.querySelector(`[data-view="${go.dataset.go}"]`).click();
  if(e.target.id==="add-holding")openHolding();if(e.target.id==="add-account")openAccount();
  const eh=e.target.closest("[data-edit-holding]");if(eh)openHolding(eh.dataset.editHolding);
  const ea=e.target.closest("[data-edit-account]");if(ea)openAccount(ea.dataset.editAccount);
  const close=e.target.closest("[data-close]");if(close)$("#"+close.dataset.close).close();
});
$("#version-history-dialog").addEventListener("click", event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
const trendDetailChart = $("#trend-detail-chart");
trendDetailChart.addEventListener("pointerover", event => showTrendPointTooltip(event.target.closest?.(".trend-detail-hit")));
trendDetailChart.addEventListener("pointerleave", event => { if (event.pointerType !== "touch") $("#trend-detail-tooltip").hidden = true; });
trendDetailChart.addEventListener("focusin", event => showTrendPointTooltip(event.target.closest?.(".trend-detail-hit")));
trendDetailChart.addEventListener("focusout", () => { $("#trend-detail-tooltip").hidden = true; });
trendDetailChart.addEventListener("click", event => showTrendPointTooltip(event.target.closest?.(".trend-detail-hit")));
const goalChart = $("#goal-chart");
goalChart.addEventListener("pointerover", event => showGoalChartTooltip(event.target.closest?.(".goal-chart-hit")));
goalChart.addEventListener("pointerleave", event => { if (event.pointerType !== "touch") $("#goal-chart-tooltip").hidden = true; });
goalChart.addEventListener("focusin", event => showGoalChartTooltip(event.target.closest?.(".goal-chart-hit")));
goalChart.addEventListener("focusout", () => { $("#goal-chart-tooltip").hidden = true; });
goalChart.addEventListener("click", event => showGoalChartTooltip(event.target.closest?.(".goal-chart-hit")));
let goalChartResizeTimer = null;
window.addEventListener("resize", () => {
  if (!latestGoalChartRender) return;
  clearTimeout(goalChartResizeTimer);
  goalChartResizeTimer = setTimeout(() => {
    if (latestGoalChartRender) renderGoalChart(latestGoalChartRender.result, latestGoalChartRender.targetAssets);
  }, 120);
});
$("#asset-goal-form").addEventListener("submit", runGoalSimulation);
$("#asset-goal-form").addEventListener("input", event => {
  if (event.target.id === "goal-current-assets") event.target.dataset.userEdited = "true";
  $("#goal-error").hidden = true;
});
["#goal-current-assets", "#goal-target-assets", "#goal-monthly-contribution"].forEach(selector => {
  $(selector).addEventListener("blur", event => {
    const raw = event.target.value.trim().replaceAll(",", "");
    const amount = raw === "" ? NaN : Number(raw);
    if (Number.isFinite(amount)) event.target.value = goalInputNumber.format(amount);
  });
});
$("#holding-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const type = $("#holding-type").value;
  const symbolField = $("#holding-symbol");
  const ideco = isIdecoCategory($("#holding-account-category").value);
  if (ideco && type !== "投資信託") {
    $("#holding-input-error").textContent = "iDeCo口座では投資信託のみ登録できます。";
    $("#holding-input-error").hidden = false;
    return;
  }
  if (type === "投資信託" || ideco) {
    symbolField.value = symbolField.value.toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(symbolField.value.trim())) {
      $("#name-lookup-status").textContent = "投信コードは半角英数字8文字で入力してください。";
      return;
    }
  }
  if ($("#lookup-name").disabled) { showHoldingInputError("銘柄情報の取得が完了してから保存してください。"); return; }
  if (confirmHoldingSymbolChange()) return;
  const quantityResult = validateHoldingField("quantity"), costResult = validateHoldingField("cost");
  if (quantityResult.error || costResult.error) {
    holdingFieldErrors.form = "";
    setHoldingFieldError("quantity", quantityResult.error || "");
    setHoldingFieldError("cost", costResult.error || "");
    return;
  }
  const quantity = quantityResult.value;
  const cost = ideco ? calculateIdecoAcquisitionUnitCost(quantity, costResult.value) : costResult.value;
  if (cost === null || !Number.isFinite(cost) || (ideco && cost > Number.MAX_SAFE_INTEGER)) {
    showHoldingInputError("保有数量と取得値を安全に扱える範囲で入力してください。"); return;
  }
  formatHoldingNumericField($("#holding-quantity"));
  formatHoldingNumericField($("#holding-cost"));
  showHoldingInputError("");
  const previousData=cloneData(data), id=$("#holding-id").value;
  const h={id:id||generateId(),accountId:$("#holding-account").value,accountCategoryCode:$("#holding-account-category").value,type,currency:$("#holding-currency").value,name:$("#holding-name").value.trim(),symbol:normalizeStoredSymbol(type,$("#holding-symbol").value.toUpperCase()),quantity,cost};
  if (!h.symbol) { $("#name-lookup-status").textContent = "銘柄コードを入力してください。"; return; }
  const old=data.holdings.findIndex(x=>x.id===id);
  const previous = old >= 0 ? data.holdings[old] : null;
  if (h.type === "日本株" && (!previous || !sameHoldingSlot(previous, h)) &&
      data.holdings.some(existing => existing.id !== h.id && sameHoldingSlot(existing, h))) {
    $("#name-lookup-status").textContent = "同じ証券口座・口座区分に、この銘柄は登録済みです。";
    return;
  }
  $("#name-lookup-status").textContent = "";
  if (old >= 0) {
    const sameQuote = normalizeStoredSymbol(previous.type, previous.symbol).toUpperCase() === h.symbol && previous.type === h.type && previous.currency === h.currency;
    data.holdings[old] = { ...previous, ...h, ...(!sameQuote ? {
      price: null, previousClose: null, priceTimestamp: null, priceDate: null, quoteStatus: "unknown", quoteAttemptedAt: null
    } : {}) };
  } else data.holdings.push(h);
  try { await persistState(previousData); $("#holding-dialog").close(); }
  catch { /* Keep the dialog open so the user can retry or reapply after a conflict. */ }
});
$("#account-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const previousData=cloneData(data),id=$("#account-id").value;
  const a={id:id||generateId(),name:$("#account-name").value.trim(),note:$("#account-note").value.trim()};
  const i=data.accounts.findIndex(x=>x.id===id);
  if(i>=0)data.accounts[i]=a;else data.accounts.push(a);
  try { await persistState(previousData); $("#account-dialog").close(); }
  catch { /* Keep the dialog open so the user can retry or reapply after a conflict. */ }
});
$("#filter-account").addEventListener("change",renderHoldingsTable);$("#filter-type").addEventListener("change",renderHoldingsTable);$("#holding-type").addEventListener("change",handleHoldingClassificationChange);$("#refresh-all").addEventListener("click",updateAll);$("#lookup-name").addEventListener("click",lookupHoldingName);
$("#holding-account").addEventListener("change", updateHoldingFormLabels);
$("#holding-account-category").addEventListener("change", handleHoldingAccountCategoryChange);
$("#holding-currency").addEventListener("change", handleHoldingClassificationChange);
$("#holding-dialog").addEventListener("cancel", () => { holdingLookupRequest++; });
$("#holding-dialog").addEventListener("close", () => {
  if ($("#holding-dialog").open) return;
  holdingLookupRequest++;
  $("#holding-symbol").disabled = false;
  $("#lookup-name").disabled = false;
});
$("#holding-symbol").addEventListener("blur", event => {
  if ($("#holding-type").value === "投資信託") event.target.value = event.target.value.toUpperCase();
});
["#holding-quantity", "#holding-cost"].forEach(selector => {
  const field = $(selector);
  field.addEventListener("focus", () => {
    // Do not silently repair malformed comma groups before they can be validated.
    if (HoldingNumberRules.decimalText(field.value) !== null) field.value = field.value.replaceAll(",", "");
  });
  field.addEventListener("blur", () => {
    const result = validateHoldingField(selector === "#holding-quantity" ? "quantity" : "cost");
    if (!result.error) formatHoldingNumericField(field);
    showHoldingInputError(result.error, selector);
    refreshIdecoAcquisitionUnitPreview();
  });
  field.addEventListener("input", () => {
    holdingFieldErrors.form = "";
    const fieldName = selector === "#holding-quantity" ? "quantity" : "cost";
    if (holdingFieldErrors[fieldName]) {
      const result = validateHoldingField(fieldName);
      setHoldingFieldError(fieldName, result.error || "");
    } else renderHoldingInputErrors();
    if (field.value.trim() !== "") delete field.dataset.cleared;
  });
});
$("#holding-name").addEventListener("input", event => {
  if (event.target.value.trim() !== "") delete event.target.dataset.cleared;
});
$("#trend-detail-account").addEventListener("change", event => {
  selectedTrendDetailAccountId = event.target.value;
  if (snapshotResponseCache) renderAssetTrendDetail(snapshotResponseCache);
});
$("#migrate-local").addEventListener("click",migrateLocalData);
$("#retry-sync").addEventListener("click",loadServerState);
let heatmapResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(heatmapResizeTimer);
  heatmapResizeTimer = setTimeout(() => {
    if (snapshotResponseCache && $("#dashboard-view").classList.contains("active")) renderAssetTrend(snapshotResponseCache);
    if (snapshotResponseCache && $("#trend-view").classList.contains("active")) renderAssetTrendDetail(snapshotResponseCache);
    if ($("#heatmap-view").classList.contains("active")) renderAssetHeatmapDetail(groupHeatmapHoldings(data.holdings || []));
  }, 120);
});
async function boot() {
  // file:// の保存領域と localhost の保存領域は別物。
  // ハッシュはサーバーへ送られないため、保有データを外部送信せずに一度だけ移行できる。
  if (location.protocol === "file:") {
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
    location.replace(`http://127.0.0.1:8766/#migration=${encodeURIComponent(encoded)}`);
    return;
  }
  await loadVersionHistory();
  const migration = new URLSearchParams(location.hash.slice(1)).get("migration");
  if (migration) {
    try {
      const migrated = JSON.parse(decodeURIComponent(escape(atob(migration))));
      if(migrated?.accounts && migrated?.holdings){ data=migrated; fxRate = Number.isFinite(data.usdJpyRate) && data.usdJpyRate > 0 ? data.usdJpyRate : null; localStorage.setItem(KEY,JSON.stringify(data)); history.replaceState({},"",location.pathname); }
    } catch { $("#quote-status").textContent = "データ移行に失敗しました。もう一度 index.html を開いてください。"; }
  }
  $("#today").textContent=new Date().toLocaleDateString("ja-JP",{year:"numeric",month:"long",day:"numeric",weekday:"short"}).toUpperCase();
  render();
  void loadMarketWeather();
  await loadServerState();
  await loadAssetTrend();
}
boot();
