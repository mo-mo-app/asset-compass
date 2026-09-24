const http = require("http");
const fs = require("fs");
const path = require("path");
const root = __dirname;
let migration = null;
const port = 8766;

const contentTypes = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
const send = (res, status, body, type="application/json; charset=utf-8") => {
  res.writeHead(status, {"Content-Type":type,"Access-Control-Allow-Origin":"*","Cache-Control":"no-store"});
  res.end(Buffer.isBuffer(body) ? body : (typeof body === "string" ? body : JSON.stringify(body)));
};
async function quote(symbol) {
  if (!/^[A-Z0-9.=^\-]+$/i.test(symbol)) throw new Error("Invalid symbol");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const response = await fetch(url, {headers:{"User-Agent":"AssetCompass/1.0"}});
  if (!response.ok) throw new Error(`Yahoo Finance returned ${response.status}`);
  const result = (await response.json()).chart?.result?.[0];
  const meta = result?.meta;
  if (!Number.isFinite(meta?.regularMarketPrice)) throw new Error("Quote unavailable");
  return {price:meta.regularMarketPrice,previousClose:meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice,priceTimestamp:Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime * 1000 : null};
}
async function stockName(symbol) {
  if (!/^[A-Z0-9.=^\-]+$/i.test(symbol)) throw new Error("Invalid symbol");
  const response = await fetch(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(symbol)}`, {headers:{"User-Agent":"Mozilla/5.0 (Asset Compass)"}});
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
  return {price:Number(match[1].replaceAll(",", "")), previousClose:null, name:name || null, priceDate};
}
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");
  if (url.pathname === "/api/name") {
    try { return send(res, 200, await stockName(url.searchParams.get("symbol") || "")); }
    catch (error) { return send(res, 502, {error:error.message}); }
  }
  if (url.pathname === "/api/quote") {
    try { const symbol=url.searchParams.get("symbol") || ""; const type=url.searchParams.get("type"); return send(res, 200, type === "投資信託" ? await fundQuote(symbol) : await quote(symbol)); }
    catch (error) { return send(res, 502, {error:error.message}); }
  }
  if (url.pathname === "/api/migrate" && req.method === "POST") {
    let body=""; req.on("data", chunk => body += chunk); req.on("end", () => { try { migration=JSON.parse(body); send(res, 201, {ok:true}); } catch { send(res, 400, {error:"Invalid data"}); } }); return;
  }
  if (url.pathname === "/api/migration") { const saved=migration; migration=null; return send(res, 200, saved || {}); }
  const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.resolve(root, `.${safePath}`);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not found", "text/plain");
  send(res, 200, fs.readFileSync(file), contentTypes[path.extname(file)] || "application/octet-stream");
}).listen(port, "127.0.0.1", () => console.log(`Asset Compass: http://127.0.0.1:${port}`));
