const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

const setup = `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const storage = require('./database');
  const { refreshClassification } = require('./classification-service');
  const { getEffectiveCode } = require('./classification-masters');
  const profile = ticker => new Response(fs.readFileSync('./tests/fixtures/classification/drillr-' + ticker + '.json', 'utf8'));
  const options = { apiKey: 'fixture-only-not-a-real-credential', logger: null, fetchImpl: async () => profile('NVDA') };
  const sample = {
    accounts: [{ id: 'a', name: 'テスト口座', note: 'メモ' }],
    holdings: [
      { id: 'nvda', accountId: 'a', type: '米国株', currency: 'USD', name: 'NVDA', symbol: 'NVDA', quantity: 2, cost: 100,
        price: 200, previousClose: 190, priceTimestamp: 1780000001000, quoteStatus: 'success', quoteAttemptedAt: 1780000001000,
        user_sector_code: 'FINANCIALS', user_industry_code: 'USER_INDUSTRY', user_sensitivity_code: 'DEFENSIVE' },
      { id: 'mu', accountId: 'a', type: '米国株', currency: 'USD', name: 'MU', symbol: 'MU', quantity: 1, cost: 100 },
      { id: 'jp1', accountId: 'a', type: '日本株', currency: 'JPY', name: '東京海上', symbol: '8766', quantity: 1, cost: 500 },
      { id: 'jp2', accountId: 'a', type: '日本株', currency: 'JPY', name: 'NTT', symbol: '9432', quantity: 1, cost: 170 },
      { id: 'fund', accountId: 'a', type: '投資信託', currency: 'JPY', name: '投信', symbol: '03311187', quantity: 10000, cost: 40000,
        auto_fund_category_code: 'BROAD_INDEX', user_fund_category_code: 'OTHER', user_sensitivity_code: 'NEUTRAL' }
    ], usdJpyRate: 150, usdJpyTimestamp: 1780000001000, lastQuoteFetchedAt: 1780000001000
  };
`;
function run(folder, code) {
  const result = spawnSync(process.execPath, ["-e", setup + `
    (async () => { try { ${code} } finally { storage.db.close(); } })()
      .catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: root, env: { ...process.env, ASSET_COMPASS_DB_PATH: path.join(folder, "state.sqlite"), DRILLR_API_KEY: "fixture-only-not-a-real-credential" }, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr.toString());
}
function temp(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "asset-compass-classification-storage-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

test("automatic classification persists three auto fields while preserving user values, prices, snapshots and cache state", t => {
  const folder = temp(t);
  run(folder, `
    storage.migrateLocalState(sample);
    let state = storage.getState();
    storage.saveState(state.revision, state.data, { quoteFailureCount: 0 });
    const snapshot = () => Object.fromEntries(['accounts','holding_quotes','fx_rates','daily_asset_snapshots','daily_account_snapshots']
      .map(table => [table, storage.db.prepare('SELECT * FROM ' + table).all()]));
    const tablesBefore = snapshot();
    const before = storage.getState();
    assert.equal((await refreshClassification('nvda', { ...options, repository: storage })).status, 'updated');
    assert.equal((await refreshClassification('mu', { ...options, repository: storage, fetchImpl: async () => profile('MU') })).status, 'updated');
    for (const [id, code] of [['jp1','8766'],['jp2','9432']]) {
      const result = await refreshClassification(id, { ...options, repository: storage,
        fetchImpl: async () => new Response(fs.readFileSync('./tests/fixtures/classification/yahoo-' + code + '.html', 'utf8')) });
      assert.equal(result.status, 'updated');
    }
    const after = storage.getState();
    const holding = after.data.holdings.find(h => h.id === 'nvda');
    assert.equal(holding.auto_sector_code, 'INFORMATION_TECHNOLOGY');
    assert.equal(holding.auto_industry_code, 'SEMICONDUCTORS');
    assert.equal(holding.auto_sensitivity_code, 'CYCLICAL');
    assert.equal(getEffectiveCode(holding, 'sector'), 'FINANCIALS');
    assert.equal(getEffectiveCode(holding, 'industry'), 'USER_INDUSTRY');
    assert.equal(getEffectiveCode(holding, 'sensitivity'), 'DEFENSIVE');
    assert.equal(after.data.holdings.find(h => h.id === 'jp1').auto_industry_code, 'INSURANCE');
    assert.equal(after.data.holdings.find(h => h.id === 'jp2').auto_industry_code, 'INFORMATION_COMMUNICATIONS');
    for (let i = 0; i < after.data.holdings.length; i++) {
      const previous = { ...before.data.holdings[i] }, current = { ...after.data.holdings[i] };
      for (const field of ['auto_sector_code','auto_industry_code','auto_sensitivity_code']) { delete previous[field]; delete current[field]; }
      assert.deepEqual(current, previous);
    }
    assert.deepEqual(snapshot(), tablesBefore);
    assert.equal(after.revision, before.revision + 4);
    assert.equal((await refreshClassification('fund', { ...options, repository: storage })).reason, 'unsupported_asset');
    // A stale browser cannot replace the server state after a classification update.
    assert.equal(storage.saveState(before.revision, before.data).conflict, true);
    // Existing JSON/LocalStorage sync can save current data without losing either class of codes.
    storage.saveState(after.revision, JSON.parse(JSON.stringify(after.data)));
    fs.writeFileSync(require('node:path').join(require('node:path').dirname(storage.databasePath), 'expected.json'), JSON.stringify(storage.getState()));
  `);
  run(folder, `
    const expected = JSON.parse(fs.readFileSync(require('node:path').join(require('node:path').dirname(storage.databasePath), 'expected.json')));
    assert.deepEqual(JSON.parse(JSON.stringify(storage.getState())), expected);
    assert.equal(storage.db.prepare('PRAGMA user_version').get().user_version, 5);
  `);
});

test("key absence, HTTP errors, parse errors, unknown values and Yahoo failures preserve existing automatic and user codes", t => {
  const folder = temp(t);
  run(folder, `
    sample.holdings[0].auto_sector_code = 'INFORMATION_TECHNOLOGY';
    sample.holdings[0].auto_industry_code = 'SEMICONDUCTORS';
    sample.holdings[0].auto_sensitivity_code = 'CYCLICAL';
    sample.holdings[2].auto_sector_code = 'FINANCIALS';
    sample.holdings[2].auto_industry_code = 'INSURANCE';
    sample.holdings[2].auto_sensitivity_code = 'NEUTRAL';
    storage.migrateLocalState(sample);
    const before = storage.getState();
    const cases = [
      { apiKey: null, fetchImpl: async () => assert.fail('missing key must not fetch') },
      ...[401,429,500].map(status => ({ fetchImpl: async () => new Response('ignored error body', { status }) })),
      { fetchImpl: async () => new Response('invalid JSON') },
      { fetchImpl: async () => { throw new Error('request failed'); } },
      { fetchImpl: async () => new Response(JSON.stringify({data:[{ticker:'NVDA',market:'US',sector:'Unknown',industry:null}]})) }
    ];
    for (const item of cases) {
      const result = await refreshClassification('nvda', { ...options, ...item, force: true, repository: storage });
      assert.notEqual(result.status, 'updated');
      assert.deepEqual(storage.getState(), before);
    }
    for (const fetchImpl of [async () => new Response('error', { status: 500 }), async () => new Response('<p>保険業</p>')]) {
      await refreshClassification('jp1', { ...options, fetchImpl, force: true, repository: storage });
      assert.deepEqual(storage.getState(), before);
    }
  `);
});

test("successful reclassification updates only valid new fields, and identical updates do not advance revision", t => {
  const folder = temp(t);
  run(folder, `
    sample.holdings[0].auto_sector_code = 'FINANCIALS';
    sample.holdings[0].auto_industry_code = 'INSURANCE';
    sample.holdings[0].auto_sensitivity_code = 'NEUTRAL';
    storage.migrateLocalState(sample);
    const changed = await refreshClassification('nvda', { ...options, force: true, repository: storage });
    assert.equal(changed.status, 'updated');
    const before = storage.getState();
    assert.equal((await refreshClassification('nvda', { ...options, repository: storage })).reason, 'already_classified');
    assert.equal((await refreshClassification('nvda', { ...options, force: true, repository: storage })).status, 'unchanged');
    assert.deepEqual(storage.getState(), before);
    const partial = await refreshClassification('nvda', { ...options, force: true, repository: storage,
      fetchImpl: async () => new Response(JSON.stringify({data:[{ticker:'NVDA',market:'US',sector:'Unknown',industry:'Software - Infrastructure'}]})) });
    assert.equal(partial.status, 'updated');
    const holding = storage.getState().data.holdings[0];
    assert.equal(holding.auto_industry_code, 'SOFTWARE_INFRASTRUCTURE');
    assert.equal(holding.auto_sector_code, 'INFORMATION_TECHNOLOGY');
    assert.equal(holding.auto_sensitivity_code, 'CYCLICAL');
    assert.equal(holding.user_sector_code, 'FINANCIALS');
  `);
});

test("classification fetch racing with a user identity/price edit cannot apply stale results", t => {
  const folder = temp(t);
  run(folder, `
    storage.migrateLocalState(sample);
    let release;
    const pending = refreshClassification('nvda', { ...options, repository: storage, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
    const state = storage.getState();
    const edited = structuredClone(state.data);
    edited.holdings[0].symbol = 'AAPL';
    edited.holdings[0].name = 'User changed company';
    edited.holdings[0].price = 250;
    edited.holdings[0].user_sector_code = 'ENERGY';
    storage.saveState(state.revision, edited);
    const afterEdit = storage.getState();
    release(profile('NVDA'));
    assert.equal((await pending).status, 'conflict');
    assert.deepEqual(storage.getState(), afterEdit);
  `);
});

test("automatic storage rejects user/fund fields, nulls and malformed codes and rolls back DB failures", t => {
  const folder = temp(t);
  run(folder, `
    storage.migrateLocalState(sample);
    const before = storage.getState();
    for (const patch of [{user_sector_code:'ENERGY'}, {auto_fund_category_code:'OTHER'}, {auto_sector_code:null},
      {auto_sector_code:''}, {auto_sector_code:'表示名'}, {auto_sector_code:42}]) {
      assert.throws(() => storage.saveAutomaticClassification('nvda', before.revision, patch));
      assert.deepEqual(storage.getState(), before);
    }
    assert.equal(storage.saveAutomaticClassification('fund', before.revision, {auto_sector_code:'ENERGY'}).reason, 'unsupported_asset');
    assert.equal(storage.saveAutomaticClassification('missing', before.revision, {auto_sector_code:'ENERGY'}).reason, 'holding_not_found');
    assert.equal(storage.saveAutomaticClassification('nvda', before.revision, {}).status, 'unchanged');
    storage.db.exec("CREATE TRIGGER reject_classification_revision BEFORE UPDATE OF revision ON app_state BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
    assert.throws(() => storage.saveAutomaticClassification('nvda', before.revision, {auto_sector_code:'ENERGY'}), /fixture rollback/);
    assert.deepEqual(storage.getState(), before);
    storage.db.exec('DROP TRIGGER reject_classification_revision');
  `);
});

test("normal refresh fills only missing automatic fields even when provider values differ", t => {
  run(temp(t), `
    sample.holdings[0].auto_sector_code = 'FINANCIALS';
    sample.holdings[0].auto_sensitivity_code = 'DEFENSIVE';
    storage.migrateLocalState(sample);
    const before = storage.getState();
    const result = await refreshClassification('nvda', { ...options, repository: storage });
    assert.equal(result.status, 'updated');
    assert.deepEqual(result.updatedFields, ['auto_industry_code']);
    const after = storage.getState();
    assert.deepEqual(after.data.holdings[0], { ...before.data.holdings[0], auto_industry_code: 'SEMICONDUCTORS' });
    assert.equal((await refreshClassification('nvda', { ...options, repository: storage,
      fetchImpl: async () => assert.fail('complete auto must not fetch') })).reason, 'already_classified');
  `);
});
