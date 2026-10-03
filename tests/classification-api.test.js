const assert = require('node:assert/strict');
const { test } = require('node:test');
const { toSaveData } = require('../classification-editor');
const { startClassificationServer } = require('./helpers/classification-server');

const holding = (id, fields = {}) => ({ id, accountId: 'a', type: '米国株', currency: 'USD', symbol: 'NVDA', name: '保存する銘柄', quantity: 2, cost: 100, ...fields });
async function setup(t, holdings = []) {
  const server = await startClassificationServer(); t.after(server.stop);
  const request = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(server.base + route, { method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const initial = await request('/api/v1/migrate-local-storage', 'POST', { data: { accounts: [{ id: 'a', name: '口座' }], holdings } });
  assert.equal(initial.status, 201);
  return { ...server, request,
    read: async () => (await request('/api/v1/state')).body,
    save: async data => {
      const current = (await request('/api/v1/state')).body;
      const result = await request('/api/v1/state', 'PUT', { expectedRevision: current.revision, data: toSaveData(data) });
      assert.equal(result.status, 200, JSON.stringify(result)); return result.body;
    }, classify: (id, body, headers) => request(`/api/v1/holdings/${id}/classification`, 'POST', body, headers) };
}
test('holding saves followed by classification persist US/JP auto values and never overwrite manual or existing auto fields', async t => {
  const api = await setup(t, [holding('us', { user_sector_code: 'ENERGY', auto_sensitivity_code: 'DEFENSIVE' })]);
  let state = await api.read();
  state.data.holdings.push(holding('jp', { type: '日本株', currency: 'JPY', symbol: '8766', user_industry_code: 'CUSTOM' }));
  const saved = await api.save(state.data);
  assert.equal(api.requests().length, 0, 'holding PUT itself does not call providers');
  const us = await api.classify('us'); assert.equal(us.status, 200);
  assert.equal(us.body.state.revision, saved.revision + 1);
  const current = us.body.state.data.holdings.find(h => h.id === 'us');
  assert.equal(current.auto_sector_code, 'INFORMATION_TECHNOLOGY');
  assert.equal(current.auto_industry_code, 'SEMICONDUCTORS');
  assert.equal(current.auto_sensitivity_code, 'DEFENSIVE');
  assert.equal(current.user_sector_code, 'ENERGY');
  const jp = await api.classify('jp'); assert.equal(jp.status, 200);
  assert.equal(jp.body.state.data.holdings.find(h => h.id === 'jp').auto_industry_code, 'INSURANCE');
  assert.equal(jp.body.state.data.holdings.find(h => h.id === 'jp').user_industry_code, 'CUSTOM');
  assert.deepEqual(await api.read(), jp.body.state);
  assert.equal((await api.classify('us', { force: true, patch: { user_sector_code: 'FINANCIALS' } })).body.classification.reason, 'already_classified');
  assert.equal(api.requests().length, 2, 'complete auto classification never fetches even with a client force flag');
  const latest = await api.read(); latest.data.holdings[0].user_sector_code = null;
  await api.save(latest.data);
  assert.equal((await api.read()).data.holdings[0].auto_sector_code, 'INFORMATION_TECHNOLOGY');
});
for (const mode of ['error', 'timeout']) test(`${mode} provider failure preserves the successful holding revision and data`, async t => {
  const api = await setup(t); api.setMode(mode);
  const state = await api.read(); state.data.holdings.push(holding('us', { user_sector_code: 'ENERGY' }));
  const saved = await api.save(state.data);
  const result = await api.classify('us'); assert.equal(result.body.classification.status, 'failed');
  assert.equal(result.body.classification.reason, mode === 'timeout' ? 'timeout' : 'http_error');
  assert.deepEqual(await api.read(), saved);
});
test('revision conflict returns 409 plus latest state, preserving the newer identity and manual edit', async t => {
  const api = await setup(t);
  const state = await api.read(); state.data.holdings.push(holding('us'));
  await api.save(state.data); api.setMode('gate');
  const pending = api.classify('us');
  for (let i = 0; !api.requests().length && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(api.requests().length, 1);
  const edit = await api.read(); edit.data.holdings[0].user_sector_code = 'ENERGY'; edit.data.holdings[0].symbol = 'AAPL';
  const saved = await api.save(edit.data); api.setMode('success');
  const result = await pending;
  assert.equal(result.status, 409); assert.equal(result.body.classification.status, 'conflict');
  assert.deepEqual(result.body.state, saved); assert.deepEqual(await api.read(), saved);
});
test('funds and known ETFs skip providers, provider ETF skips auto saving, and cross-origin classification writes are rejected', async t => {
  const api = await setup(t, [holding('etf', { auto_fund_category_code: 'BROAD_INDEX' })]);
  const state = await api.read(); state.data.holdings.push(holding('fund', { type: '投資信託', currency: 'JPY', symbol: '03311187' }),
    holding('manual-etf', { user_fund_category_code: 'OTHER' }), holding('us'));
  const saved = await api.save(state.data);
  for (const id of ['fund', 'etf', 'manual-etf']) assert.equal((await api.classify(id)).body.classification.reason, 'unsupported_asset');
  assert.equal(api.requests().length, 0);
  assert.equal((await api.classify('missing')).body.classification.reason, 'holding_not_found');
  assert.equal((await api.classify('us', null, { Origin: 'https://other.example.com' })).status, 403);
  assert.deepEqual(await api.read(), saved);
  api.setMode('etf');
  assert.equal((await api.classify('us')).body.classification.reason, 'unsupported_asset');
  assert.deepEqual(await api.read(), saved);
  assert.equal((await fetch(api.base + '/classification-masters.js')).status, 200);
  assert.equal((await fetch(api.base + '/classification-service.js')).status, 404);
});

test('SOXL holding save remains successful when the existing service skips a provider-reported ETF', async t => {
  const api = await setup(t); api.setMode('etf');
  const state = await api.read();
  state.data.holdings.push(holding('soxl', { symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X Shares' }));
  const saved = await api.save(state.data);
  const result = await api.classify('soxl');
  assert.equal(result.status, 200);
  assert.equal(result.body.classification.reason, 'unsupported_asset');
  assert.deepEqual(await api.read(), saved);
});
