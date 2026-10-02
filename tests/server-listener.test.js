const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");

function listeners(env) {
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, "server.js"), "utf8"), {
    __dirname: root, process: { env }, console: { log() {}, error() {} },
    require(name) {
      if (name === "http") return { createServer() { return {
        on() {}, listen(port, host) { calls.push({ port, host }); }
      }; } };
      if (name === "os") return { networkInterfaces() { return {
        eth0: [{ address: "172.20.0.2", family: "IPv4", internal: false }],
        wlan0: [{ address: "192.168.1.2", family: "IPv4", internal: false }],
        public: [{ address: "203.0.113.2", family: "IPv4", internal: false }]
      }; } };
      if (name === "./database") return {};
      return require(name.startsWith("./") ? path.join(root, name) : name);
    }
  });
  return calls;
}

test("without a host override, localhost and detected LAN listeners retain their order and default port", () => {
  assert.deepEqual(listeners({}), [
    { port: 8766, host: "127.0.0.1" },
    { port: 8766, host: "192.168.1.2" },
    { port: 8766, host: "172.20.0.2" }
  ]);
  assert.deepEqual(listeners({ ASSET_COMPASS_HOST: "", ASSET_COMPASS_BIND_LAN: "false", ASSET_COMPASS_PORT: "9000" }),
    [{ port: 9000, host: "127.0.0.1" }]);
});

test("an explicit host creates exactly one listener even when LAN interfaces are available", () => {
  for (const host of ["0.0.0.0", "127.0.0.1"]) {
    assert.deepEqual(listeners({ ASSET_COMPASS_HOST: host, ASSET_COMPASS_PORT: "8080" }),
      [{ port: 8080, host }]);
  }
});

for (const mode of ["Railway", "Codex Cloud"]) {
  test(`${mode} startup serves the page and shared data API`, async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-listener-"));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const probe = net.createServer();
    await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const env = { ...process.env, ASSET_COMPASS_DB_PATH: path.join(folder, "state.sqlite"), ASSET_COMPASS_PORT: String(port) };
    delete env.ASSET_COMPASS_HOST;
    delete env.ASSET_COMPASS_BIND_LAN;
    if (mode === "Railway") env.ASSET_COMPASS_HOST = "0.0.0.0";
    else env.ASSET_COMPASS_BIND_LAN = "false";
    const child = spawn(process.execPath, [...(mode === "Codex Cloud" ? ["--use-env-proxy"] : []), "server.js"],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise(resolve => child.once("exit", resolve));
        child.kill(); await exit;
      }
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { ready = (await fetch(`${base}/api/v1/state`)).ok; } catch { /* Starting. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, output);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Asset Compass/);
    const state = await fetch(`${base}/api/v1/state`);
    assert.equal(state.status, 200);
    assert.equal((await state.json()).apiVersion, 1);
    assert.doesNotMatch(output, /EADDRINUSE|起動に失敗/);
  });
}

test("single-listener port conflict exits with a nonzero status", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-conflict-"));
  const blocker = net.createServer();
  await new Promise((resolve, reject) => blocker.listen(0, "0.0.0.0", resolve).once("error", reject));
  t.after(async () => {
    await new Promise(resolve => blocker.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const child = spawn(process.execPath, ["server.js"], { cwd: root,
    env: { ...process.env, ASSET_COMPASS_HOST: "0.0.0.0", ASSET_COMPASS_PORT: String(blocker.address().port), ASSET_COMPASS_DB_PATH: path.join(folder, "state.sqlite") },
    stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stderr.on("data", chunk => output += chunk);
  const timer = setTimeout(() => child.kill(), 5000);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(result.signal, null, "server should exit without forced termination");
  assert.equal(result.code, 1);
  assert.match(output, /EADDRINUSE/);
});
