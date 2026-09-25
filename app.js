const KEY = "asset-compass-v1";
const LOCAL_BACKUP_KEY = "asset-compass-v1-pre-sync-backup";
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
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
const hasValuation = (h) => hasQuote(h) && (h.currency !== "USD" || Number.isFinite(fxRate));
const valueOf = (h) => hasValuation(h) ? h.price * h.quantity / quantityDivisor(h) * (h.currency === "USD" ? fxRate : 1) : null;
const costOf = (h) => h.currency === "USD" && !Number.isFinite(fxRate) ? null : h.cost * h.quantity / quantityDivisor(h) * (h.currency === "USD" ? fxRate : 1);
const gainClass = (n) => n > 0 ? "positive" : n < 0 ? "negative" : "";
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${yen.format(Math.abs(n))}`;
const account = (id) => data.accounts.find(a => a.id === id);

// Local-currency daily change. null means unknown/unusable; 0 means unchanged.
// A successful request is not proof of today's market data: retain the source
// priceTimestamp/priceDate for freshness decisions in a future heatmap.
function dailyChangePercent(holding) {
  if (holding.quoteStatus !== "success" || !Number.isFinite(holding.price) || holding.price < 0 ||
      !Number.isFinite(holding.previousClose) || holding.previousClose <= 0) return null;
  return (holding.price - holding.previousClose) / holding.previousClose * 100;
}

function render() {
  const holdings = data.holdings;
  const quoted = holdings.filter(hasQuote);
  const missingQuotes = holdings.length - quoted.length;
  const valued = holdings.filter(hasValuation);
  const total = valued.reduce((n,h) => n + valueOf(h), 0);
  const cost = valued.reduce((n,h) => n + costOf(h), 0);
  const gain = total - cost;
  const canCompareDay = holdings.length > 0 && valued.length === holdings.length && holdings.every(h => dailyChangePercent(h) !== null);
  const day = canCompareDay ? valued.reduce((n,h) => n + (h.price - h.previousClose) * h.quantity / quantityDivisor(h) * (h.currency === "USD" ? fxRate : 1), 0) : null;
  $("#total-value").textContent = valued.length ? yen.format(total) : "—";
  $("#total-cost").textContent = valued.length ? `取得額 ${yen.format(cost)}${missingQuotes ? `（未取得 ${missingQuotes}件を除く）` : ""}` : holdings.some(h => hasQuote(h) && h.currency === "USD") ? "為替レート取得後に表示" : "価格を更新してください";
  $("#total-gain").textContent = valued.length ? signed(gain) : "—";
  $("#total-gain").className = gainClass(gain);
  $("#total-gain-rate").textContent = cost ? `${(gain / cost * 100).toFixed(2)}%` : "—";
  $("#total-gain-rate").className = gainClass(gain);
  $("#day-gain").textContent = day !== null ? signed(day) : "—";
  $("#day-gain").className = gainClass(day);
  $("#day-gain-rate").textContent = day !== null && total - day > 0 ? `${(day / (total - day) * 100).toFixed(2)}%` : "—";
  $("#day-gain-rate").className = gainClass(day);
  $("#asset-count").textContent = holdings.length ? `${holdings.length} 銘柄` : "";
  $("#quote-status").textContent = holdings.length ? `価格取得済み ${quoted.length}/${holdings.length}件${missingQuotes ? ` ／ 未取得 ${missingQuotes}件` : ""}` : "登録済みの銘柄はありません";
  const failedQuotes = holdings.filter(h => h.quoteStatus === "failed").length;
  if (failedQuotes) $("#quote-status").textContent += ` ／ 今回取得失敗 ${failedQuotes}件（取得済みの価格は保持）`;
  $("#last-fetch-at").textContent = data.lastQuoteFetchedAt ? `最終取得 ${formatDateTime(data.lastQuoteFetchedAt)}` : "";
  $("#usd-jpy-rate").textContent = Number.isFinite(fxRate) ? `USD/JPY ${fxRate.toFixed(2)}` : "USD/JPY —";
  $("#usd-jpy-timestamp").textContent = Number.isFinite(data.usdJpyTimestamp) ? `為替日時 ${formatDateTime(data.usdJpyTimestamp)}` : "";
  const heatmapGroups = groupHeatmapHoldings(holdings);
  renderAllocation(total); renderAccountSummary(); renderAssetHeatmap(heatmapGroups); renderAssetHeatmapDetail(heatmapGroups); renderDashboardHoldings(); renderHoldingsTable(); renderAccounts(); renderAccountOptions();
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
    return `<li class="allocation-legend-row"><span class="allocation-legend-name"><i style="--allocation-color:${colors[index]}"></i>${type}</span><span class="allocation-legend-values"><b>${percentage.toFixed(1)}%</b><small>${yen.format(value)}</small></span></li>`;
  }).join("");
  $("#allocation").innerHTML = `<div class="allocation-chart-layout"><div class="allocation-donut" role="img" aria-label="資産配分 ${types.map(([type, value]) => `${type} ${(value / total * 100).toFixed(1)}%`).join("、")}" style="--allocation-chart:conic-gradient(${segments})"><div class="allocation-donut-center"><small>総資産評価額</small><b>${yen.format(total)}</b></div></div><ul class="allocation-legend">${details}</ul></div>`;
}
function renderAccountSummary() {
  const rows = data.accounts.map(a => { const hs=data.holdings.filter(h=>h.accountId===a.id), valued=hs.filter(hasValuation); return `<div class="account-summary-row"><span>${escapeHTML(a.name)}</span><b>${valued.length ? yen.format(valued.reduce((n,h) => n + valueOf(h),0)) : "—"}</b></div>`; }).join("");
  $("#account-summary").className = rows ? "account-summary" : "account-summary empty-state";
  $("#account-summary").innerHTML = rows || "証券口座を追加してください";
}
function groupHeatmapHoldings(holdings) {
  const groups = new Map();
  for (const holding of holdings) {
    const key = `${holding.type}\u0000${holding.currency}\u0000${String(holding.symbol || "").trim().toUpperCase()}`;
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

function heatmapSpansForRow(row) {
  const columns = 16;
  const minimumSpan = 2;
  const spans = row.map(() => minimumSpan);
  let remaining = columns - spans.length * minimumSpan;
  if (remaining <= 0) return spans;
  const weights = row.map(item => item.valueJpy ** 0.75);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = weights.map(weight => remaining * weight / weightTotal);
  shares.forEach((share, index) => {
    const whole = Math.floor(share);
    spans[index] += whole;
    remaining -= whole;
  });
  const order = shares.map((share, index) => ({ index, remainder: share - Math.floor(share), value: row[index].valueJpy }))
    .sort((a, b) => b.remainder - a.remainder || b.value - a.value);
  for (let i = 0; i < remaining; i++) spans[order[i].index]++;
  return spans;
}

function heatmapMovementClass(changePercent) {
  if (changePercent === null || !Number.isFinite(changePercent)) return "unknown";
  const magnitude = Math.abs(changePercent);
  if (magnitude < 0.25) return "neutral";
  const level = magnitude < 1 ? 1 : magnitude < 2.5 ? 2 : magnitude < 5 ? 3 : 4;
  return `${changePercent > 0 ? "positive" : "negative"}-${level}`;
}

function renderHeatmapTiles(groups, { fullTypes = false } = {}) {
  const rows = [];
  for (let index = 0; index < groups.length; index += 4) rows.push(groups.slice(index, index + 4));
  const html = rows.map(row => {
    const spans = heatmapSpansForRow(row);
    return row.map((group, index) => {
      const holding = group.representative;
      const symbol = String(holding.symbol || holding.name || "—").trim();
      const change = group.changePercent === null ? "—" : `${group.changePercent > 0 ? "+" : ""}${group.changePercent.toFixed(1)}%`;
      const kind = fullTypes ? holding.type : holding.type === "投資信託" ? "投信" : holding.type;
      const name = `${holding.name || symbol}（${symbol}）`;
      const changeLabel = group.changePercent === null ? "本日の騰落率は不明" : `本日の騰落率 ${change}`;
      return `<article class="heatmap-tile" role="group" aria-label="${escapeHTML(name)}・${yen.format(group.valueJpy)}・${changeLabel}" data-movement="${heatmapMovementClass(group.changePercent)}" data-size="${spans[index] <= 3 ? "small" : "large"}" data-span="${spans[index]}" style="grid-column:span ${spans[index]}" title="${escapeHTML(name)}・${yen.format(group.valueJpy)}・${changeLabel}"><span class="heatmap-symbol">${escapeHTML(symbol)}</span><strong class="heatmap-change">${change}</strong><small class="heatmap-type">${escapeHTML(kind)}</small></article>`;
    }).join("");
  }).join("");
  return html;
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
    const symbol = String(holding.symbol || holding.name || "—").trim();
    const isFund = holding.type === "投資信託";
    const primaryLabel = isFund ? String(holding.name || symbol).trim() : symbol;
    const change = rectangle.group.changePercent === null ? "—" : `${rectangle.group.changePercent > 0 ? "+" : ""}${rectangle.group.changePercent.toFixed(1)}%`;
    const share = rectangle.share;
    const labelDensity = share < 0.02 ? "symbol" : share < 0.055 ? "compact" : "full";
    const name = `${holding.name || symbol}（${symbol}）`;
    const kind = holding.type;
    const changeLabel = rectangle.group.changePercent === null ? "本日の騰落率は不明" : `本日の騰落率 ${change}`;
    const position = `left:${rectangle.x / aspectRatio * 100}%;top:${rectangle.y * 100}%;width:${rectangle.width / aspectRatio * 100}%;height:${rectangle.height * 100}%`;
    return `<article class="heatmap-treemap-tile" role="group" aria-label="${escapeHTML(name)}・${yen.format(rectangle.group.valueJpy)}・${changeLabel}" data-movement="${heatmapMovementClass(rectangle.group.changePercent)}" data-label-density="${labelDensity}" data-asset-type="${isFund ? "fund" : "stock"}" style="${position}" title="${escapeHTML(name)}・${yen.format(rectangle.group.valueJpy)}・${changeLabel}"><span class="heatmap-treemap-symbol${isFund ? " heatmap-treemap-fund-name" : ""}">${escapeHTML(primaryLabel)}</span><strong class="heatmap-treemap-change">${change}</strong><small class="heatmap-treemap-type">${escapeHTML(kind)}</small></article>`;
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
    const symbol = String(holding.symbol || holding.name || "—").trim();
    const kind = holding.type === "投資信託" ? "投信" : holding.type;
    return `<li><span><strong>${escapeHTML(symbol)}</strong><small>${escapeHTML(holding.name || symbol)} · ${escapeHTML(kind)}</small></span><b>評価額 —</b></li>`;
  }).join("")}</ul></section>` : "";
  container.className = "heatmap-detail-content";
  container.innerHTML = `${tiles}${unvalued}`;
}
function holdingRow(h, compact = false) {
  const value = valueOf(h), gain = hasValuation(h) ? value - costOf(h) : null, rate = gain !== null && costOf(h) ? gain / costOf(h) * 100 : null;
  const marketDate = h.type === "投資信託" ? formatFundDate(h.priceDate) : formatDateTime(h.priceTimestamp);
  const marketLabel = h.type === "投資信託" ? "基準日" : "価格日時";
  const quantityLabel = h.type === "投資信託" ? "保有口数" : "保有数量";
  return `<div class="holding-row"><div class="holding-identity"><div class="holding-name">${escapeHTML(h.name)}</div><div class="holding-meta">${escapeHTML(h.symbol)} · ${escapeHTML(account(h.accountId)?.name || "—")}</div>${marketDate ? `<div class="holding-updated">${marketLabel} ${marketDate}</div>` : ""}</div><div class="holding-cell optional holding-current"><small>現在値</small><span class="money">${hasQuote(h) ? number.format(h.price) + " " + h.currency : "未取得"}</span></div><div class="holding-cell holding-value ${compact ? 'hide-mobile' : ''}"><small>評価額</small><span class="money">${value !== null ? yen.format(value) : "—"}</span></div><div class="holding-cell optional holding-gain"><small>評価損益</small><span class="gain ${gainClass(gain || 0)}">${gain !== null ? `${signed(gain)}<br>${rate.toFixed(2)}%` : "—"}</span></div><div class="holding-cell holding-type ${compact ? 'hide-mobile' : ''}"><small>資産区分</small><span>${h.type}</span></div><button class="icon-button holding-menu" data-edit-holding="${h.id}" aria-label="編集">⋮</button><div class="holding-cell holding-quantity"><small>${quantityLabel}</small><span>${number.format(h.quantity)}</span></div></div>`;
}
function renderDashboardHoldings() { $("#dashboard-holdings").innerHTML = data.holdings.length ? data.holdings.slice(0,5).map(h => holdingRow(h,true)).join("") : `<div class="empty-state" style="height:100px">まだ保有資産がありません</div>`; }
function renderHoldingsTable() {
  const a = $("#filter-account").value, t = $("#filter-type").value;
  const list = data.holdings.filter(h => (a === "all" || h.accountId === a) && (t === "all" || h.type === t));
  $("#holdings-table").innerHTML = list.length ? `<div class="holding-row table-head"><div>銘柄 / 口座</div><div class="optional">現在値</div><div>評価額</div><div class="optional">評価損益</div><div>資産区分</div><div></div></div>${list.map(h => holdingRow(h)).join("")}` : `<div class="empty-state" style="height:160px">「保有資産を追加」から最初の銘柄を登録してください</div>`;
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
function renderAssetTrend(response) {
  const series = buildSnapshotSeries(response, "total");
  const latest = series.filter(point => point.valueJpy !== null);
  const latestPoint = latest[latest.length - 1] || null;
  const previousPoint = latest.length > 1 ? latest[latest.length - 2] : null;
  const latestValue = $("#asset-trend-latest");
  const deltaValue = $("#asset-trend-delta");
  const message = $("#asset-trend-message");
  const chart = $("#asset-trend-chart");
  const lines = $("#asset-trend-lines");
  const markers = $("#asset-trend-points");

  latestValue.textContent = latestPoint ? yen.format(latestPoint.valueJpy) : "—";
  deltaValue.className = "";
  if (previousPoint) {
    const delta = latestPoint.valueJpy - previousPoint.valueJpy;
    deltaValue.textContent = delta > 0 ? `+${yen.format(delta)}` : delta < 0 ? `-${yen.format(Math.abs(delta))}` : yen.format(0);
    deltaValue.className = delta > 0 ? "positive" : delta < 0 ? "negative" : "";
  } else {
    deltaValue.textContent = "—";
  }

  const rangeEnd = typeof response?.to === "string" ? response.to : series[series.length - 1]?.date;
  const cutoff = shiftSnapshotDate(rangeEnd, -29);
  const recentSeries = cutoff ? series.filter(point => point.date >= cutoff && point.date <= rangeEnd) : series.slice(-30);
  const recentValues = recentSeries.filter(point => point.valueJpy !== null);
  lines.replaceChildren();
  markers.replaceChildren();
  if (!recentValues.length) {
    chart.hidden = true;
    message.hidden = false;
    message.textContent = series.length ? "最近の評価額データはありません" : "価格更新後に資産推移を表示します";
    return;
  }

  message.hidden = true;
  chart.hidden = false;
  const values = recentValues.map(point => point.valueJpy);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = 320;
  const height = 64;
  const padding = 7;
  const coordinates = recentSeries.map((point, index) => {
    if (point.valueJpy === null) return null;
    const x = recentSeries.length < 2 ? width / 2 : index / (recentSeries.length - 1) * width;
    const y = max === min ? height / 2 : padding + (max - point.valueJpy) / (max - min) * (height - padding * 2);
    return { point, x, y };
  });

  const segments = [];
  let segment = [];
  for (const coordinate of coordinates) {
    if (coordinate) segment.push(coordinate);
    else if (segment.length) { segments.push(segment); segment = []; }
  }
  if (segment.length) segments.push(segment);
  lines.innerHTML = segments.filter(points => points.length > 1).map(points =>
    `<path class="asset-trend-line" d="${points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}" />`
  ).join("");
  markers.innerHTML = coordinates.filter(Boolean).map(({ point, x, y }) =>
    `<circle class="asset-trend-point" data-date="${point.date}" data-complete="${point.isComplete}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" />`
  ).join("");
}
async function loadAssetTrend({ refresh = false } = {}) {
  if (snapshotFetchPromise) await snapshotFetchPromise;
  if (!refresh && snapshotResponseCache) {
    renderAssetTrend(snapshotResponseCache);
    return snapshotResponseCache;
  }
  snapshotFetchPromise = (async () => {
    try {
      const response = await fetch("/api/v1/snapshots", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.snapshots)) throw new Error(payload.error || "資産推移を取得できませんでした");
      snapshotResponseCache = payload;
      renderAssetTrend(payload);
      return payload;
    } catch {
      if (snapshotResponseCache) renderAssetTrend(snapshotResponseCache);
      else {
        $("#asset-trend-latest").textContent = "—";
        $("#asset-trend-delta").textContent = "—";
        $("#asset-trend-chart").hidden = true;
        $("#asset-trend-message").hidden = false;
        $("#asset-trend-message").textContent = "資産推移を読み込めませんでした";
      }
      return null;
    } finally {
      snapshotFetchPromise = null;
    }
  })();
  return snapshotFetchPromise;
}
function formatFundDate(value) { return typeof value === "string" && /^\d{1,2}\/\d{1,2}$/.test(value) ? value : ""; }
function renderAccounts() {
  $("#accounts-list").innerHTML = data.accounts.map(a => { const list=data.holdings.filter(h=>h.accountId===a.id), valued=list.filter(hasValuation), value=valued.reduce((n,h)=>n+valueOf(h),0); return `<article class="account-card"><div class="account-card-top"><div><h3>${escapeHTML(a.name)}</h3><p class="account-note">${escapeHTML(a.note || "メモなし")}</p></div><button class="icon-button" data-edit-account="${a.id}">⋮</button></div><p class="account-card-value">${valued.length ? yen.format(value) : "—"}</p><p class="account-card-count">${list.length} 銘柄を保有</p></article>`; }).join("");
}
function renderAccountOptions() { const current = $("#filter-account").value; $("#filter-account").innerHTML = `<option value="all">すべての口座</option>${data.accounts.map(a=>`<option value="${a.id}">${escapeHTML(a.name)}</option>`).join("")}`; $("#filter-account").value = current; }
function escapeHTML(s) { const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }
function updateHoldingFormLabels() {
  const isFund = $("#holding-type").value === "投資信託";
  $("#quantity-label").textContent = isFund ? "保有口数" : "保有数量";
  $("#cost-label").textContent = isFund ? "取得基準価額（1万口あたり）" : "取得単価";
  $("#holding-quantity").placeholder = isFund ? "例：150000" : "例：100";
  $("#holding-cost").placeholder = isFund ? "例：10000" : "例：2500";
  $("#fund-unit-note").hidden = !isFund;
}
function openHolding(id) {
  const h=data.holdings.find(x=>x.id===id); $("#holding-form").reset(); $("#holding-id").value=id||""; $("#holding-dialog-title").textContent=h?"保有資産を編集":"保有資産を追加"; $("#holding-form-kicker").textContent=h?"EDIT HOLDING":"NEW HOLDING"; $("#holding-account").innerHTML=data.accounts.map(a=>`<option value="${a.id}">${escapeHTML(a.name)}</option>`).join(""); if(h){ $("#holding-account").value=h.accountId; $("#holding-type").value=h.type; $("#holding-currency").value=h.currency; $("#holding-name").value=h.name; $("#holding-symbol").value=h.symbol; $("#holding-quantity").value=h.quantity; $("#holding-cost").value=h.cost; } updateHoldingFormLabels(); $("#holding-dialog").showModal();
}
function openAccount(id) { const a=data.accounts.find(x=>x.id===id); $("#account-form").reset(); $("#account-id").value=id||""; $("#account-dialog-title").textContent=a?"証券口座を編集":"証券口座を追加"; $("#account-form-kicker").textContent=a?"EDIT ACCOUNT":"NEW ACCOUNT"; if(a){$("#account-name").value=a.name;$("#account-note").value=a.note} $("#account-dialog").showModal(); }
async function lookupHoldingName() {
  const button = $("#lookup-name"), status = $("#name-lookup-status");
  const symbol = $("#holding-symbol").value.trim().toUpperCase(), type = $("#holding-type").value;
  if (!symbol) { status.textContent = "先に銘柄コードを入力してください"; return; }
  button.disabled = true; status.textContent = "取得中…";
  try {
    const res = type === "投資信託"
      ? await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}&type=${encodeURIComponent(type)}`)
      : await fetch(`/api/name?symbol=${encodeURIComponent(symbol)}`);
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "銘柄情報を取得できませんでした");
    if (!result.name) throw new Error("銘柄名を取得できませんでした。銘柄名を手入力してください。");
    $("#holding-name").value = result.name; status.textContent = "銘柄名を入力しました。必要に応じて修正できます。";
  } catch (error) { status.textContent = `${error.message} 銘柄名は手入力できます。`; }
  finally { button.disabled = false; }
}
async function updateQuote(h) {
  h.quoteAttemptedAt = Date.now();
  try {
    const symbol = encodeURIComponent(h.symbol.trim().toUpperCase());
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
  for(const h of data.holdings){try{await updateQuote(h)}catch(error){errors.push(`${h.name}（${h.symbol}）`)}}
  data.lastQuoteFetchedAt=Date.now();
  try {
    await persistState(previousData, { quoteFailureCount: errors.length + Number(fxQuoteFailed) });
    await loadAssetTrend({ refresh: true });
    if(errors.length) $("#quote-status").textContent=`価格を取得できませんでした：${errors.join("、")}。投信は8桁の投信コードを入力してください。`;
  } catch { /* persistState restores the last confirmed state and shows the error. */ }
  finally {button.disabled=false;button.innerHTML="↻ <span>価格を更新</span>";}
}
function showAppView(viewName) {
  const view = $(`#${viewName}-view`);
  if (!view) return;
  const selectedNavView = viewName === "heatmap" ? "dashboard" : viewName;
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === selectedNavView));
  document.querySelectorAll(".view").forEach(item => item.classList.toggle("active", item === view));
  $("#page-title").textContent = {
    dashboard: "資産の全体像", holdings: "保有資産", accounts: "証券口座", heatmap: "資産ヒートマップ"
  }[viewName];
  if (viewName === "heatmap") window.scrollTo(0, 0);
}

document.addEventListener("click", e => {
  const nav=e.target.closest(".nav-item");
  if(nav)showAppView(nav.dataset.view);
  const heatmapDetails=e.target.closest("[data-heatmap-details]");if(heatmapDetails)showAppView("heatmap");
  const go=e.target.closest("[data-go]");if(go)document.querySelector(`[data-view="${go.dataset.go}"]`).click();
  if(e.target.id==="add-holding")openHolding();if(e.target.id==="add-account")openAccount();
  const eh=e.target.closest("[data-edit-holding]");if(eh)openHolding(eh.dataset.editHolding);
  const ea=e.target.closest("[data-edit-account]");if(ea)openAccount(ea.dataset.editAccount);
  const close=e.target.closest("[data-close]");if(close)$("#"+close.dataset.close).close();
});
$("#holding-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const previousData=cloneData(data), id=$("#holding-id").value;
  const h={id:id||generateId(),accountId:$("#holding-account").value,type:$("#holding-type").value,currency:$("#holding-currency").value,name:$("#holding-name").value.trim(),symbol:$("#holding-symbol").value.trim().toUpperCase(),quantity:Number($("#holding-quantity").value),cost:Number($("#holding-cost").value)};
  const old=data.holdings.findIndex(x=>x.id===id);
  if (old >= 0) {
    const previous = data.holdings[old];
    const sameQuote = previous.symbol === h.symbol && previous.type === h.type && previous.currency === h.currency;
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
$("#filter-account").addEventListener("change",renderHoldingsTable);$("#filter-type").addEventListener("change",renderHoldingsTable);$("#holding-type").addEventListener("change",updateHoldingFormLabels);$("#refresh-all").addEventListener("click",updateAll);$("#lookup-name").addEventListener("click",lookupHoldingName);
$("#migrate-local").addEventListener("click",migrateLocalData);
$("#retry-sync").addEventListener("click",loadServerState);
let heatmapResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(heatmapResizeTimer);
  heatmapResizeTimer = setTimeout(() => {
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
  const migration = new URLSearchParams(location.hash.slice(1)).get("migration");
  if (migration) {
    try {
      const migrated = JSON.parse(decodeURIComponent(escape(atob(migration))));
      if(migrated?.accounts && migrated?.holdings){ data=migrated; fxRate = Number.isFinite(data.usdJpyRate) && data.usdJpyRate > 0 ? data.usdJpyRate : null; localStorage.setItem(KEY,JSON.stringify(data)); history.replaceState({},"",location.pathname); }
    } catch { $("#quote-status").textContent = "データ移行に失敗しました。もう一度 index.html を開いてください。"; }
  }
  $("#today").textContent=new Date().toLocaleDateString("ja-JP",{year:"numeric",month:"long",day:"numeric",weekday:"short"}).toUpperCase();
  render();
  await loadServerState();
  await loadAssetTrend();
}
boot();
