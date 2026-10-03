const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { publicEnvironment, renderIndexHtml } = require("../environment-view");
const root = path.resolve(__dirname, "..");

const source = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

test("only the preview environment classification is exposed; all other values resolve to local", () => {
  assert.equal(publicEnvironment(undefined), "local");
  assert.equal(publicEnvironment(""), "local");
  assert.equal(publicEnvironment("local"), "local");
  assert.equal(publicEnvironment("preview"), "preview");
  assert.equal(publicEnvironment("https://example.up.railway.app/private-token"), "local");
});

test("local HTML retains its title and favicon while preview HTML gets only the safe preview marker", () => {
  const local = renderIndexHtml(source, "local");
  assert.match(local, /<html lang="ja" data-environment="local">/);
  assert.match(local, /<title>Asset Compass \| 資産管理<\/title>/);
  assert.match(local, /href="\/assets\/favicon\.svg"/);
  assert.doesNotMatch(local, /<title>\[PREVIEW\]/);

  const secretLikeValue = "https://example.up.railway.app/path?token=do-not-leak";
  const preview = renderIndexHtml(source, "preview");
  assert.match(preview, /<html lang="ja" data-environment="preview">/);
  assert.match(preview, /<title>\[PREVIEW\] Asset Compass<\/title>/);
  assert.match(preview, /content="#2b203d"/);
  assert.match(preview, /href="\/assets\/favicon-preview\.svg"/);
  assert.doesNotMatch(preview, /ASSET_COMPASS_ENV|Railway|railway\.app|token=/i);

  const unknown = renderIndexHtml(source, secretLikeValue);
  assert.match(unknown, /data-environment="local"/);
  assert.equal(unknown.includes(secretLikeValue), false);
});

async function startHttpServer(t, configuredValue) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-environment-view-"));
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, ASSET_COMPASS_HOST: "127.0.0.1", ASSET_COMPASS_PORT: String(port),
    ASSET_COMPASS_DB_PATH: path.join(folder, "state.sqlite") };
  if (configuredValue === undefined) delete env.ASSET_COMPASS_ENV;
  else env.ASSET_COMPASS_ENV = configuredValue;
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(stderr || "server exited before listening");
    try {
      const response = await fetch(base + "/", { signal: AbortSignal.timeout(500) });
      if (response.ok) return { base, response };
    } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(stderr || "server did not start");
}

test("HTTP server serves the local appearance by default and the preview appearance only in preview", async t => {
  for (const [configuredValue, environment, title, favicon] of [
    [undefined, "local", "Asset Compass | 資産管理", "/assets/favicon.svg"],
    ["preview", "preview", "[PREVIEW] Asset Compass", "/assets/favicon-preview.svg"]
  ]) {
    const server = await startHttpServer(t, configuredValue);
    const html = await server.response.text();
    assert.match(html, new RegExp(`<html lang="ja" data-environment="${environment}">`));
    assert.match(html, new RegExp(`<title>${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<\\/title>`));
    assert.match(html, new RegExp(`href="${favicon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.doesNotMatch(html, /ASSET_COMPASS_ENV|RAILWAY|DATABASE_URL|secret/i);
    const icon = await fetch(server.base + favicon);
    assert.equal(icon.status, 200);
    assert.match(await icon.text(), environment === "preview" ? /#c2a0f4/ : /#57d6b1/);
  }
});
