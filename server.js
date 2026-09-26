const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { stockQuoteFromChart, fundPreviousClose } = require("./quote-data");
const { toQuoteSymbol } = require("./symbols");
const { getState, getSnapshots, migrateLocalState, saveState } = require("./database");
const root = __dirname;
let migration = null;
const port = Number(process.env.ASSET_COMPASS_PORT) || 8766;
const bindLan = process.env.ASSET_COMPASS_BIND_LAN !== "false";
const publicFiles = new Set(["index.html", "app.js", "symbols.js", "styles.css", "funds.css"]);

const contentTypes = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
const send = (res, status, body, type="application/json; charset=utf-8") => {
  res.writeHead(status, {"Content-Type":type,"Cache-Control":"no-store"});
  res.end(Buffer.isBuffer(body) ? body : (typeof body === "string" ? body : JSON.stringify(body)));
};
function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "", size = 0, tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", chunk => {
      size += Buffer.byteLength(chunk);
      if (size > limit) tooLarge = true;
      else if (!tooLarge) body += chunk;
    });
    req.on("end", () => {
      if (tooLarge) return reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
      try { resolve(JSON.parse(body)); }
      catch { reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}
function isSameOriginMutation(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const protocol = req.socket.encrypted ? "https:" : "http:";
    return parsed.protocol === protocol && parsed.host.toLowerCase() === String(req.headers.host || "").toLowerCase();
  } catch { return false; }
}
function apiError(res, error) {
  const status = error.statusCode || (error.message.startsWith("Request body") ? 400 : 400);
  return send(res, status, { error: error.message });
}
function jstToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function shiftDate(date, days) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}
function isValidSnapshotDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(year, month - 1, day);
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}
async function quote(symbol, type) {
  const quoteSymbol = toQuoteSymbol(type, symbol);
  if (!/^[A-Z0-9.=^\-]+$/i.test(quoteSymbol)) throw new Error("Invalid symbol");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(quoteSymbol)}?range=1mo&interval=1d`;
  const response = await fetch(url, {headers:{"User-Agent":"AssetCompass/1.0"}});
  if (!response.ok) throw new Error(`Yahoo Finance returned ${response.status}`);
  const result = (await response.json()).chart?.result?.[0];
  return stockQuoteFromChart(result);
}
async function stockName(symbol, type) {
  const quoteSymbol = toQuoteSymbol(type, symbol);
  if (!/^[A-Z0-9.=^\-]+$/i.test(quoteSymbol)) throw new Error("Invalid symbol");
  const response = await fetch(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(quoteSymbol)}`, {headers:{"User-Agent":"Mozilla/5.0 (Asset Compass)"}});
  if (!response.ok) throw new Error("Yahoo!ファイナンスで銘柄コードが見つかりません");
  const html = await response.text();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!title) throw new Error("Yahoo!ファイナンスから銘柄名を取得できませんでした");
  const name = title.replace(/\s*[-｜|]\s*Yahoo!?ファイナンス.*$/i, "").replace(/[【〖][^】〗]*[】〗].*$/, "").replace(/&amp;/g, "&").trim();
  if (!name) throw new Error("Yahoo!ファイナンスから銘柄名を取得できませんでした");
  return {name};
}
async function fundQuote(code) {
  if (!/^\d{8}$/.test(code)) throw new Error("投信コードは8桁で入力してください");
  const response = await fetch(`https://finance.yahoo.co.jp/quote/${code}`, {headers:{"User-Agent":"Mozilla/5.0 (Asset Compass)"}});
  if (!response.ok) throw new Error("Yahoo!ファイナンスで投信コードが見つかりません");
  const html = await response.text();
  const match = html.match(/_CommonPriceBoard__price_[^>]*>[\s\S]{0,500}?_StyledNumber__value_[^>]*>([\d,]+)/);
  if (!match) throw new Error("投信の基準価額を取得できませんでした");
  const nearbyText = html.slice(match.index, match.index + 1600).replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#xA0;/gi, " ").replace(/&amp;/g, "&");
  const dateMatch = nearbyText.match(/(?<!\d)(?:((?:19|20)\d{2})[年\/-])?(\d{1,2})[月\/-](\d{1,2})日?(?!\d)/);
  const priceDate = dateMatch ? `${dateMatch[2]}/${dateMatch[3]}` : null;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const name = titleMatch ? titleMatch[1].replace(/\s*[-｜|]\s*Yahoo!?ファイナンス.*$/i, "").replace(/[【〖][^】〗]*[】〗].*$/, "").replace(/&amp;/g, "&").trim() : null;
  const price = Number(match[1].replaceAll(",", ""));
  const previousClose = fundPreviousClose(html.slice(match.index, match.index + 4000), price);
  return {price, previousClose, name:name || null, priceDate};
}
const handleRequest = async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");
  if (url.pathname === "/api/v1/state" && req.method === "GET") return send(res, 200, getState());
  if (url.pathname === "/api/v1/snapshots" && req.method === "GET") {
    const today = jstToday();
    let from = url.searchParams.has("from") ? url.searchParams.get("from") : null;
    let to = url.searchParams.has("to") ? url.searchParams.get("to") : null;
    if (from !== null && !isValidSnapshotDate(from)) return send(res, 400, { error: "from must be a valid YYYY-MM-DD date." });
    if (to !== null && !isValidSnapshotDate(to)) return send(res, 400, { error: "to must be a valid YYYY-MM-DD date." });
    if (from === null && to === null) {
      to = today;
      from = shiftDate(today, -89);
    } else if (from === null) {
      from = shiftDate(to, -89);
    } else if (to === null) {
      to = today;
    }
    if (from > to) return send(res, 400, { error: "from must be on or before to." });
    return send(res, 200, { apiVersion: 1, from, to, snapshots: getSnapshots(from, to) });
  }
  if (url.pathname === "/api/v1/state" && req.method === "PUT") {
    if (!isSameOriginMutation(req)) return send(res, 403, { error: "Cross-origin state changes are not allowed." });
    try {
      const body = await readJson(req);
      const result = saveState(body?.expectedRevision, body?.data, body?.snapshot ?? null);
      if (result.notInitialized) return send(res, 409, { error: "state_not_initialized", currentRevision: result.state.revision });
      if (result.conflict) return send(res, 409, { error: "revision_conflict", currentRevision: result.state.revision, currentUpdatedAt: result.state.updatedAt });
      return send(res, 200, result.snapshot ? { ...result.state, snapshot: result.snapshot } : result.state);
    } catch (error) { return apiError(res, error); }
  }
  if (url.pathname === "/api/v1/migrate-local-storage" && req.method === "POST") {
    if (!isSameOriginMutation(req)) return send(res, 403, { error: "Cross-origin state changes are not allowed." });
    try {
      const body = await readJson(req);
      const result = migrateLocalState(body?.data);
      if (result.conflict) return send(res, 409, { error: "already_initialized", currentRevision: result.state.revision });
      return send(res, 201, { ...result.state, accountsCount: result.accountsCount, holdingsCount: result.holdingsCount });
    } catch (error) { return apiError(res, error); }
  }
  if (url.pathname === "/api/name") {
    try { return send(res, 200, await stockName(url.searchParams.get("symbol") || "", url.searchParams.get("type"))); }
    catch (error) { return send(res, 502, {error:error.message}); }
  }
  if (url.pathname === "/api/quote") {
    try { const symbol=url.searchParams.get("symbol") || ""; const type=url.searchParams.get("type"); return send(res, 200, type === "投資信託" ? await fundQuote(symbol) : await quote(symbol, type)); }
    catch (error) { return send(res, 502, {error:error.message}); }
  }
  if (url.pathname === "/api/migrate" && req.method === "POST") {
    let body=""; req.on("data", chunk => body += chunk); req.on("end", () => { try { migration=JSON.parse(body); send(res, 201, {ok:true}); } catch { send(res, 400, {error:"Invalid data"}); } }); return;
  }
  if (url.pathname === "/api/migration") { const saved=migration; migration=null; return send(res, 200, saved || {}); }
  const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.resolve(root, `.${safePath}`);
  const relativeFile = path.relative(root, file).split(path.sep).join("/");
  if (relativeFile.startsWith("..") || !publicFiles.has(relativeFile) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not found", "text/plain");
  send(res, 200, fs.readFileSync(file), contentTypes[path.extname(file)] || "application/octet-stream");
};

function isPrivateIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

const interfaces = os.networkInterfaces();
const lanAddresses = Object.entries(interfaces)
  .flatMap(([name, entries]) => (entries || []).map(entry => ({name, ...entry})))
  .filter(entry => !entry.internal && (entry.family === "IPv4" || entry.family === 4) && isPrivateIPv4(entry.address))
  .sort((a, b) => Number(!/wi-?fi|wireless|wlan/i.test(a.name)) - Number(!/wi-?fi|wireless|wlan/i.test(b.name)));

function startListener(host, label) {
  const server = http.createServer(handleRequest);
  server.on("error", error => console.error(`${label} (${host}) の起動に失敗しました: ${error.message}`));
  server.listen(port, host, () => console.log(`${label}: http://${host}:${port}`));
}

startListener("127.0.0.1", "PC内アクセス");
if (bindLan && lanAddresses.length) {
  lanAddresses.forEach((entry, index) => startListener(entry.address, index === 0 ? "同一LANアクセス" : `LANアクセス候補 (${entry.name})`));
} else if (bindLan) {
  console.log("同一LAN用のプライベートIPv4アドレスが見つかりませんでした。");
}
