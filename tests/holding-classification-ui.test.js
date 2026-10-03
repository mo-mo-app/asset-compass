const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { prepare } = require('./helpers/holding-ui');

const saveButtonSelector = "#holding-form button[value='default']";
const auto = { auto_sector_code: 'INFORMATION_TECHNOLOGY', auto_industry_code: 'SEMICONDUCTORS', auto_sensitivity_code: 'CYCLICAL' };
function setup(options = {}) {
  const ui = prepare({ type: '米国株', currency: 'USD', symbol: 'NVDA', quantity: 2, cost: 100, ...options });
  const { context, rows } = ui;
  ui.reset = () => { for (const row of rows.values()) if (!row.row.hidden) row.reset.fire('click'); };
  vm.runInContext('serverRevision = 1; serverConnected = true; serverInitialized = true; persistState = realPersistState;', context);
  let current = { initialized: true, revision: 1, data: JSON.parse(vm.runInContext('JSON.stringify(data)', context)) };
  const requests = [];
  const response = (payload, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(payload) });
  const api = { classify: async () => {
    current.data.holdings[0] = { ...current.data.holdings[0], ...auto };
    current.revision++;
    return response({ classification: { status: 'updated' }, state: current });
  }, response, get current() { return current; }, set current(value) { current = value; } };
  context.fetch = async (url, options = {}) => {
    requests.push([options.method || 'GET', url]);
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      assert.equal(body.expectedRevision, current.revision);
      current = { initialized: true, revision: current.revision + 1, data: { ...body.data, holdings: body.data.holdings.map(h => ({ ...current.data.holdings.find(previous => previous.id === h.id), ...h })) } };
      return response(current);
    }
    if (options.method === 'POST') return api.classify();
    return response(current);
  };
  return { ...ui, api, requests };
}
for (const type of ['米国株', '日本株']) test(`${type} new save completes classification after PUT and reopens with current automatic values`, async () => {
  const ui = setup({ existing: false, type, currency: type === '日本株' ? 'JPY' : 'USD', symbol: type === '日本株' ? '8766' : 'NVDA' });
  await ui.save();
  assert.deepEqual(ui.requests.map(([method]) => method), ['PUT', 'POST']);
  assert.deepEqual(Object.fromEntries(Object.keys(auto).map(field => [field, ui.state()[0][field]])), auto);
  assert.equal(ui.element('#holding-dialog').open, false);
  ui.context.openHolding(ui.state()[0].id);
  assert.equal(ui.rows.get('sector').input.value, auto.auto_sector_code);
  assert.equal(ui.rows.get('industry').input.value, auto.auto_industry_code);
  assert.equal(ui.rows.get('sensitivity').input.value, auto.auto_sensitivity_code);
  assert.equal(vm.runInContext('serverRevision', ui.context), 3);
});
test('complete auto classification and excluded assets never call the classification API', async () => {
  for (const fields of [auto, { auto_fund_category_code: 'BROAD_INDEX' }, { user_fund_category_code: 'OTHER' }]) {
    const ui = setup();
    ui.context.fields = fields;
    vm.runInContext('Object.assign(data.holdings[0], fields)', ui.context);
    Object.assign(ui.api.current.data.holdings[0], fields);
    await ui.save();
    assert.deepEqual(ui.requests.map(([method]) => method), ['PUT']);
  }
  const ui = setup({ type: '投資信託', currency: 'JPY', symbol: '03311187' });
  await ui.save();
  assert.deepEqual(ui.requests.map(([method]) => method), ['PUT']);
});
test('automatic results retain manual priority; reset previews and saves null user codes while retaining auto', async () => {
  const ui = setup();
  ui.context.fields = { user_sector_code: 'FINANCIALS', user_sensitivity_code: 'DEFENSIVE' };
  vm.runInContext('Object.assign(data.holdings[0], fields)', ui.context);
  ui.context.openHolding('holding-1');
  await ui.save();
  ui.context.openHolding('holding-1');
  assert.equal(ui.rows.get('sector').input.value, 'FINANCIALS');
  assert.equal(ui.rows.get('sensitivity').input.value, 'DEFENSIVE');
  assert.equal(ui.rows.get('industry').input.value, 'SEMICONDUCTORS');
  assert.equal(ui.rows.get('sector').auto, null);
  ui.reset();
  assert.equal(ui.rows.get('sector').input.value, auto.auto_sector_code);
  assert.equal(ui.rows.get('sensitivity').input.value, auto.auto_sensitivity_code);
  await ui.save();
  for (const kind of ['sector', 'industry', 'sensitivity']) assert.equal(ui.state()[0][`user_${kind}_code`], null);
  assert.equal(ui.requests.filter(([method]) => method === 'POST').length, 1);
  ui.context.openHolding('holding-1');
  assert.equal(ui.rows.get('sector').input.value, auto.auto_sector_code);
});
test('a partial manual edit writes only that user field and still fetches missing auto codes', async () => {
  const ui = setup();
  ui.rows.get('sector').input.value = 'ENERGY';
  ui.rows.get('sector').input.fire('change');
  await ui.save();
  assert.equal(ui.state()[0].user_sector_code, 'ENERGY');
  assert.equal(ui.state()[0].user_industry_code, undefined);
  assert.equal(ui.state()[0].auto_sector_code, auto.auto_sector_code);
});
for (const failure of ['provider', 'timeout', 'http', 'conflict']) test(`${failure} classification failure retains the successful holding save`, async () => {
  const ui = setup();
  ui.element('#holding-name').value = '保存された銘柄';
  ui.api.classify = async () => {
    if (failure === 'timeout') throw new Error('timeout');
    if (failure === 'conflict') {
      ui.api.current.data.holdings[0].user_sector_code = 'ENERGY';
      ui.api.current.revision++;
      return ui.api.response({ classification: { status: 'conflict' }, state: ui.api.current }, 409);
    }
    if (failure === 'http') return ui.api.response({ error: 'classification_failed' }, 502);
    return ui.api.response({ classification: { status: 'failed' }, state: ui.api.current });
  };
  await ui.save();
  assert.equal(ui.state()[0].name, '保存された銘柄');
  assert.equal(ui.element('#holding-dialog').open, false);
  assert.match(ui.element('#sync-message').textContent, /銘柄は保存しました。自動分類は反映できませんでした/);
  if (failure === 'conflict') assert.equal(ui.state()[0].user_sector_code, 'ENERGY');
  else assert.equal(vm.runInContext('serverRevision', ui.context), 2);
});
test('a failed holding PUT never starts automatic classification and retains the input draft', async () => {
  const ui = setup();
  let calls = 0;
  ui.context.fetch = async () => { calls++; return ui.api.response({ error: 'failed' }, 500); };
  ui.element('#holding-name').value = '未保存の編集';
  await ui.save();
  assert.equal(calls, 1);
  assert.equal(ui.state()[0].name, '元の銘柄');
  assert.equal(ui.element('#holding-name').value, '未保存の編集');
  assert.equal(ui.element('#holding-dialog').open, true);
});
test('late classification preserves form edits and blocks duplicate submits while pending', async () => {
  const ui = setup({ existing: false });
  let release;
  const started = new Promise(resolve => { ui.api.classify = () => { resolve(); return new Promise(r => { release = r; }); }; });
  const pending = ui.save(); await started;
  assert.equal(ui.element(saveButtonSelector).disabled, true);
  assert.match(ui.element(saveButtonSelector).textContent, /自動分類中/);
  ui.element('#holding-name').value = '次の編集';
  ui.rows.get('sector').input.value = 'ENERGY';
  ui.rows.get('sector').input.fire('change');
  await ui.save();
  release(ui.api.response({ classification: { status: 'updated' }, state: { ...ui.api.current, revision: 3,
    data: { ...ui.api.current.data, holdings: [{ ...ui.api.current.data.holdings[0], ...auto }] } } }));
  await pending;
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.element('#holding-dialog').open, true);
  assert.equal(ui.element('#holding-name').value, '次の編集');
  assert.equal(ui.rows.get('sector').input.value, 'ENERGY');
  assert.equal(ui.element('#holding-id').value, ui.state()[0].id);
  assert.equal(ui.element(saveButtonSelector).disabled, false);
  ui.element('#holding-dialog').close();
  ui.context.openHolding(ui.state()[0].id);
  assert.equal(ui.rows.get('sector').input.value, auto.auto_sector_code, 'the existing editor reopens with the latest automatic baseline');
});
for (const change of ['local', 'saved', 'reopened']) test(`late classification cannot overwrite a ${change} edit or close another dialog session`, async () => {
  const ui = setup();
  let release;
  const started = new Promise(resolve => { ui.api.classify = () => { resolve(); return new Promise(r => { release = r; }); }; });
  const pending = ui.save(); await started;
  const stale = structuredClone(ui.api.current); stale.revision++; Object.assign(stale.data.holdings[0], auto);
  if (change === 'local') vm.runInContext('data.holdings[0].user_sector_code = "ENERGY"', ui.context);
  if (change === 'saved') {
    const latest = structuredClone(stale); latest.revision++; latest.data.holdings[0].user_sector_code = 'ENERGY';
    ui.context.applyServerState(latest);
  }
  if (change === 'reopened') { ui.element('#holding-dialog').close(); ui.context.openHolding('holding-1'); ui.element('#holding-name').value = '新しい編集'; }
  release(ui.api.response({ classification: { status: 'updated' }, state: stale })); await pending;
  if (change !== 'reopened') assert.equal(ui.state()[0].user_sector_code, 'ENERGY');
  else { assert.equal(ui.element('#holding-dialog').open, true); assert.equal(ui.element('#holding-name').value, '新しい編集'); }
});

test('failure to fetch latest state after classification failure preserves the confirmed holding and draft', async () => {
  const ui = setup(); const fetch = ui.context.fetch;
  ui.api.classify = async () => { throw new Error('classification unavailable'); };
  ui.context.fetch = (url, options) => options?.method ? fetch(url, options) : Promise.reject(new Error('state unavailable'));
  ui.element('#holding-name').value = '保存済み';
  await ui.save();
  assert.equal(ui.state()[0].name, '保存済み');
  assert.equal(vm.runInContext('serverRevision', ui.context), 2);
  assert.match(ui.element('#sync-message').textContent, /銘柄は保存しました/);
});

test('advanced classification settings begin closed and close again when another edit session opens', () => {
  const ui = setup();
  const advanced = ui.element('#holding-advanced-settings');
  assert.equal(advanced.open, false);
  advanced.open = true;
  ui.element('#holding-dialog').close();
  ui.context.openHolding('holding-1');
  assert.equal(advanced.open, false);
  advanced.open = true;
  ui.element('#holding-dialog').close();
  ui.context.openHolding('');
  assert.equal(advanced.open, false);
});
