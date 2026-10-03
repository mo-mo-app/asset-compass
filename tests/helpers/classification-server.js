const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

async function startClassificationServer() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-compass-classification-api-'));
  const control = path.join(folder, 'control.json');
  const log = path.join(folder, 'requests.txt');
  const preload = path.join(folder, 'preload.cjs');
  fs.writeFileSync(control, JSON.stringify({ mode: 'success' }));
  fs.writeFileSync(log, '');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const root = ${JSON.stringify(root)};
    global.fetch = async (url, { signal }) => {
      fs.appendFileSync(${JSON.stringify(log)}, url + '\\n');
      const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
      let mode = read().mode;
      if (mode === 'gate') {
        while (read().mode === 'gate') {
          if (signal.aborted) throw new Error('aborted');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        mode = read().mode;
      }
      if (mode === 'timeout') return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
      if (mode === 'error') return new Response('error', { status: 500 });
      if (url.includes('gateway.drillr.ai')) {
        if (mode === 'etf') return Response.json({ data: [{ ticker: new URL(url).searchParams.get('ticker'), market: 'US', isEtf: true }] });
        return new Response(fs.readFileSync(root + '/tests/fixtures/classification/drillr-NVDA.json', 'utf8'));
      }
      return new Response(fs.readFileSync(root + '/tests/fixtures/classification/yahoo-8766.html', 'utf8'));
    };
    const service = require(root + '/classification-service');
    const refresh = service.refreshClassification;
    service.refreshClassification = id => refresh(id, { apiKey: 'fixture-only-not-a-real-credential', timeoutMs: 500, logger: null });
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (_port, ...args) {
      this.on('listening', () => console.log('TEST_PORT=' + this.address().port));
      return listen.call(this, 0, ...args);
    };
  `);
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: root, env: { ...process.env, ASSET_COMPASS_HOST: '127.0.0.1', ASSET_COMPASS_DB_PATH: path.join(folder, 'state.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(folder, { recursive: true, force: true });
  };
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/TEST_PORT=(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', () => reject(new Error(output)));
  });
  return { base: `http://127.0.0.1:${port}`, stop,
    setMode: mode => fs.writeFileSync(control, JSON.stringify({ mode })),
    requests: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}
module.exports = { startClassificationServer };
