const KEY = "asset-compass-v1";
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
let data = JSON.parse(localStorage.getItem(KEY) || "null") || { accounts: [{id: generateId(), name: "証券口座 1", note: ""}], holdings: [] };
let fxRate = 150;

const $ = (s) => document.querySelector(s);
const save = () => localStorage.setItem(KEY, JSON.stringify(data));
// 国内投信の基準価額は、通常「1万口あたり」。保有口数は実口数で入力する。
const quantityDivisor = (h) => h.type === "投資信託" ? 10000 : 1;
const hasQuote = (h) => Number.isFinite(h.price);
const valueOf = (h) => hasQuote(h) ? h.price * h.quantity / quantityDivisor(h) * (h.currency === "USD" ? fxRate : 1) : null;
const costOf = (h) => h.cost * h.quantity / quantityDivisor(h) * (h.currency === "USD" ? fxRate : 1);
const gainClass = (n) => n > 0 ? "positive" : n < 0 ? "negative" : "";
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${yen.format(Math.abs(n))}`;
const account = (id) => data.accounts.find(a => a.id === id);

function render() {
  const holdings = data.holdings;
  const quoted = holdings.filter(hasQuote);
  const missingQuotes = holdings.length - quoted.length;
  const total = quoted.reduce((n,h) => n + valueOf(h), 0);
  const cost = quoted.reduce((n,h) => n + costOf(h), 0);
  const gain = total - cost;
  const day = quoted.reduce((n,h) => n + (h.price - (h.previousClose ?? h.price)) * h.quantity / quantityDivisor(h) * (h.currency === "USD" ? fxRate : 1), 0);
  $("#total-value").textContent = quoted.length ? yen.format(total) : "—";
  $("#total-cost").textContent = quoted.length ? `取得額 ${yen.format(cost)}${missingQuotes ? `（未取得 ${missingQuotes}件を除く）` : ""}` : "価格を更新してください";
  $("#total-gain").textContent = quoted.length ? signed(gain) : "—";
  $("#total-gain").className = gainClass(gain);
  $("#total-gain-rate").textContent = cost ? `${(gain / cost * 100).toFixed(2)}%` : "—";
  $("#total-gain-rate").className = gainClass(gain);
  $("#day-gain").textContent = quoted.length ? signed(day) : "—";
  $("#day-gain").className = gainClass(day);
  $("#day-gain-rate").textContent = total - day ? `${(day / (total - day) * 100).toFixed(2)}%` : "—";
  $("#day-gain-rate").className = gainClass(day);
  $("#asset-count").textContent = holdings.length ? `${holdings.length} 銘柄` : "";
  $("#quote-status").textContent = holdings.length ? `価格取得済み ${quoted.length}/${holdings.length}件${missingQuotes ? ` ／ 未取得 ${missingQuotes}件` : ""}` : "登録済みの銘柄はありません";
  $("#last-fetch-at").textContent = data.lastQuoteFetchedAt ? `最終取得 ${formatDateTime(data.lastQuoteFetchedAt)}` : "";
  renderAllocation(total); renderAccountSummary(); renderDashboardHoldings(); renderHoldingsTable(); renderAccounts(); renderAccountOptions();
}
function renderAllocation(total) {
  const types = ["日本株", "米国株", "投資信託"].map(type => [type, data.holdings.filter(h => h.type === type && hasQuote(h)).reduce((n,h) => n + valueOf(h), 0)]).filter(x => x[1]);
  $("#allocation").className = types.length ? "allocation" : "allocation empty-state";
  $("#allocation").innerHTML = types.length ? types.map(([type,val]) => `<div class="allocation-row"><span>${type}</span><div class="bar"><i style="width:${val / total * 100}%"></i></div><b>${(val / total * 100).toFixed(1)}%</b></div>`).join("") : "保有資産を追加すると配分を表示します";
}
function renderAccountSummary() {
  const rows = data.accounts.map(a => { const hs=data.holdings.filter(h=>h.accountId===a.id), quoted=hs.filter(hasQuote); return `<div class="account-summary-row"><span>${escapeHTML(a.name)}</span><b>${quoted.length ? yen.format(quoted.reduce((n,h) => n + valueOf(h),0)) : "—"}</b></div>`; }).join("");
  $("#account-summary").className = rows ? "account-summary" : "account-summary empty-state";
  $("#account-summary").innerHTML = rows || "証券口座を追加してください";
}
function holdingRow(h, compact = false) {
  const value = valueOf(h), gain = hasQuote(h) ? value - costOf(h) : null, rate = gain !== null && costOf(h) ? gain / costOf(h) * 100 : null;
  const marketDate = h.type === "投資信託" ? formatFundDate(h.priceDate) : formatDateTime(h.priceTimestamp);
  const marketLabel = h.type === "投資信託" ? "基準日" : "価格日時";
  const quantityLabel = h.type === "投資信託" ? "保有口数" : "保有数量";
  return `<div class="holding-row"><div class="holding-identity"><div class="holding-name">${escapeHTML(h.name)}</div><div class="holding-meta">${escapeHTML(h.symbol)} · ${escapeHTML(account(h.accountId)?.name || "—")}</div>${marketDate ? `<div class="holding-updated">${marketLabel} ${marketDate}</div>` : ""}</div><div class="holding-cell optional holding-current"><small>現在値</small><span class="money">${hasQuote(h) ? number.format(h.price) + " " + h.currency : "未取得"}</span></div><div class="holding-cell holding-value ${compact ? 'hide-mobile' : ''}"><small>評価額</small><span class="money">${hasQuote(h) ? yen.format(value) : "—"}</span></div><div class="holding-cell optional holding-gain"><small>評価損益</small><span class="gain ${gainClass(gain || 0)}">${gain !== null ? `${signed(gain)}<br>${rate.toFixed(2)}%` : "—"}</span></div><div class="holding-cell holding-type ${compact ? 'hide-mobile' : ''}"><small>資産区分</small><span>${h.type}</span></div><button class="icon-button holding-menu" data-edit-holding="${h.id}" aria-label="編集">⋮</button><div class="holding-cell holding-quantity"><small>${quantityLabel}</small><span>${number.format(h.quantity)}</span></div></div>`;
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
function formatFundDate(value) { return typeof value === "string" && /^\d{1,2}\/\d{1,2}$/.test(value) ? value : ""; }
function renderAccounts() {
  $("#accounts-list").innerHTML = data.accounts.map(a => { const list=data.holdings.filter(h=>h.accountId===a.id), quoted=list.filter(hasQuote), value=quoted.reduce((n,h)=>n+valueOf(h),0); return `<article class="account-card"><div class="account-card-top"><div><h3>${escapeHTML(a.name)}</h3><p class="account-note">${escapeHTML(a.note || "メモなし")}</p></div><button class="icon-button" data-edit-account="${a.id}">⋮</button></div><p class="account-card-value">${quoted.length ? yen.format(value) : "—"}</p><p class="account-card-count">${list.length} 銘柄を保有</p></article>`; }).join("");
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
  const symbol = encodeURIComponent(h.symbol.trim().toUpperCase());
  const type = encodeURIComponent(h.type || "");
  const res = await fetch(`/api/quote?symbol=${symbol}&type=${type}`);
  if (!res.ok) { const error = await res.json().catch(() => ({})); throw new Error(error.error || "取得できませんでした"); }
  const quote = await res.json(); if(!Number.isFinite(quote.price)) throw new Error("価格がありません");
  h.price=quote.price; h.previousClose=quote.previousClose ?? h.price;
  if (Number.isFinite(quote.priceTimestamp) && quote.priceTimestamp > 0) h.priceTimestamp=quote.priceTimestamp;
  if (typeof quote.priceDate === "string" && /^\d{1,2}\/\d{1,2}$/.test(quote.priceDate)) h.priceDate=quote.priceDate;
}
async function updateAll() {
  if(!data.holdings.length)return; const button=$("#refresh-all");button.disabled=true;button.innerHTML="⌛ <span>更新中…</span>";const errors=[];
  try { const fxQuote = {symbol:"JPY=X", currency:"JPY"}; await updateQuote(fxQuote); fxRate = fxQuote.price || fxRate; } catch {}
  for(const h of data.holdings){try{await updateQuote(h)}catch(error){errors.push(`${h.name}（${h.symbol}）`)}}
  data.lastQuoteFetchedAt=Date.now();
  save();render();button.disabled=false;button.innerHTML="↻ <span>価格を更新</span>"; if(errors.length) $("#quote-status").textContent=`価格を取得できませんでした：${errors.join("、")}。投信は8桁の投信コードを入力してください。`;
}
document.addEventListener("click", e => { const nav=e.target.closest(".nav-item"); if(nav){document.querySelectorAll(".nav-item,.view").forEach(x=>x.classList.remove("active"));nav.classList.add("active");$(`#${nav.dataset.view}-view`).classList.add("active");$("#page-title").textContent={dashboard:"資産の全体像",holdings:"保有資産",accounts:"証券口座"}[nav.dataset.view];} const go=e.target.closest("[data-go]");if(go)document.querySelector(`[data-view="${go.dataset.go}"]`).click();if(e.target.id==="add-holding")openHolding();if(e.target.id==="add-account")openAccount();const eh=e.target.closest("[data-edit-holding]");if(eh)openHolding(eh.dataset.editHolding);const ea=e.target.closest("[data-edit-account]");if(ea)openAccount(ea.dataset.editAccount);const close=e.target.closest("[data-close]");if(close)$("#"+close.dataset.close).close(); });
$("#holding-form").addEventListener("submit", e=>{e.preventDefault();const id=$("#holding-id").value;const h={id:id||generateId(),accountId:$("#holding-account").value,type:$("#holding-type").value,currency:$("#holding-currency").value,name:$("#holding-name").value.trim(),symbol:$("#holding-symbol").value.trim().toUpperCase(),quantity:Number($("#holding-quantity").value),cost:Number($("#holding-cost").value)};const old=data.holdings.findIndex(x=>x.id===id);if(old>=0)data.holdings[old]={...data.holdings[old],...h};else data.holdings.push(h);save();$("#holding-dialog").close();render();});
$("#account-form").addEventListener("submit",e=>{e.preventDefault();const id=$("#account-id").value,a={id:id||generateId(),name:$("#account-name").value.trim(),note:$("#account-note").value.trim()};const i=data.accounts.findIndex(x=>x.id===id);if(i>=0)data.accounts[i]=a;else data.accounts.push(a);save();$("#account-dialog").close();render();});
$("#filter-account").addEventListener("change",renderHoldingsTable);$("#filter-type").addEventListener("change",renderHoldingsTable);$("#holding-type").addEventListener("change",updateHoldingFormLabels);$("#refresh-all").addEventListener("click",updateAll);$("#lookup-name").addEventListener("click",lookupHoldingName);
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
      if(migrated?.accounts && migrated?.holdings){ data=migrated; save(); history.replaceState({},"",location.pathname); }
    } catch { $("#quote-status").textContent = "データ移行に失敗しました。もう一度 index.html を開いてください。"; }
  }
  $("#today").textContent=new Date().toLocaleDateString("ja-JP",{year:"numeric",month:"long",day:"numeric",weekday:"short"}).toUpperCase();render();
}
boot();
