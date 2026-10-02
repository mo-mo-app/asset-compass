const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const root = path.resolve(__dirname, "..");

async function server(t, trust) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-proxy-"));
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, ASSET_COMPASS_HOST: "127.0.0.1", ASSET_COMPASS_PORT: String(port), ASSET_COMPASS_DB_PATH: path.join(folder, "state.sqlite") };
  delete env.ASSET_COMPASS_TRUST_PROXY;
  if (trust !== undefined) env.ASSET_COMPASS_TRUST_PROXY = trust;
  const child = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try {
      if ((await fetch(base + "/api/v1/state", { signal: AbortSignal.timeout(1000) })).ok) return base;
    } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Server did not start: " + output);
}
async function read(base) { return (await fetch(base + "/api/v1/state")).json(); }
function mutate(base, method, headers, body) {
  // Preserve the proxy-facing Host header rather than letting fetch replace it.
  return new Promise((resolve, reject) => {
    const request = http.request(base + (method === "POST" ? "/api/v1/migrate-local-storage" : "/api/v1/state"), {
      method, headers: { "Content-Type": "application/json", ...headers }, signal: AbortSignal.timeout(2000)
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => text += chunk);
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, json: async () => JSON.parse(text) }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}
async function initializeAndSave(base, headers) {
  const initial = await read(base);
  const migrated = await mutate(base, "POST", headers, { data: initial.data });
  assert.equal(migrated.status, 201);
  const state = await migrated.json();
  const saved = await mutate(base, "PUT", headers, { expectedRevision: state.revision, data: state.data });
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.equal(result.revision, state.revision + 1);
  assert.deepEqual(await read(base), result);
}
const publicHeaders = { Host: "example.up.railway.app", Origin: "https://example.up.railway.app", "X-Forwarded-Proto": "https" };

test("trusted proxy permits HTTPS-origin migration POST and state PUT over HTTP", async t => {
  const base = await server(t, "true");
  await initializeAndSave(base, publicHeaders);
});

for (const trust of [undefined, "false", "TRUE"]) {
  test(`proxy trust ${String(trust)} ignores forwarded protocol and rejects HTTPS writes without changing data`, async t => {
    const base = await server(t, trust);
    const initial = await read(base);
    const rejected = await mutate(base, "POST", publicHeaders, { data: initial.data });
    assert.equal(rejected.status, 403);
    assert.deepEqual(await read(base), initial);
    await initializeAndSave(base, { Origin: base, "X-Forwarded-Proto": "https" });
    const state = await read(base);
    assert.equal((await mutate(base, "PUT", publicHeaders, { expectedRevision: state.revision, data: state.data })).status, 403);
    assert.deepEqual(await read(base), state);
  });
}

test("trusted proxy rejects mismatched and malformed headers without changing state", async t => {
  const base = await server(t, "true");
  const cases = [
    { ...publicHeaders, Origin: "https://other.example.com" },
    { ...publicHeaders, Origin: "http://example.up.railway.app" },
    { ...publicHeaders, "X-Forwarded-Proto": "http" },
    { ...publicHeaders, "X-Forwarded-Proto": "ftp" },
    { ...publicHeaders, "X-Forwarded-Proto": "https,http" },
    { ...publicHeaders, "X-Forwarded-Proto": "https, https" },
    { ...publicHeaders, "X-Forwarded-Proto": "" },
    { ...publicHeaders, "X-Forwarded-Proto": "HTTPS" },
    { ...publicHeaders, Origin: "https://other.example.com", "X-Forwarded-Host": "other.example.com" },
    { Host: "example.up.railway.app", "X-Forwarded-Proto": "invalid" }
  ];
  const initial = await read(base);
  for (const headers of cases) {
    assert.equal((await mutate(base, "POST", headers, { data: initial.data })).status, 403, JSON.stringify(headers));
    assert.deepEqual(await read(base), initial);
  }
  await initializeAndSave(base, publicHeaders);
  const state = await read(base);
  for (const headers of cases) {
    assert.equal((await mutate(base, "PUT", headers, { expectedRevision: state.revision, data: state.data })).status, 403, JSON.stringify(headers));
    assert.deepEqual(await read(base), state);
  }
});

for (const trust of [undefined, "true"]) {
  test(`HTTP same-origin writes work without forwarded headers (trust ${String(trust)})`, async t => {
    const base = await server(t, trust);
    await initializeAndSave(base, { Origin: base });
  });
}

test("forwarded host is ignored when the actual Host matches Origin", async t => {
  const base = await server(t, "true");
  await initializeAndSave(base, { ...publicHeaders, "X-Forwarded-Host": "unrelated.example.com" });
});
