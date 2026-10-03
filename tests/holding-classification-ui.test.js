const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { normalizeStoredSymbol } = require('../symbols');
const classificationFields = require('../classification-editor').fields.flatMap(field => [field.auto, field.user]);
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
      current = { initialized: true, revision: current.revision + 1, data: { ...body.data, holdings: body.data.holdings.map(h => {
        const previous = current.data.holdings.find(previous => previous.id === h.id);
        const changed = previous && (previous.type !== h.type || normalizeStoredSymbol(previous.type, previous.symbol).toUpperCase() !== normalizeStoredSymbol(h.type, h.symbol).toUpperCase());
        return { ...previous, ...(changed ? Object.fromEntries(classificationFields.map(field => [field, null])) : {}), ...h };
      }) } };
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
  assert.equal(ui.rows.has('industry'), false);
  assert.equal(ui.state()[0].auto_industry_code, auto.auto_industry_code);
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
test('opening a different holding clears the previous session cleared background while restoring its symbol', () => {
  const ui = setup();
  const second = { ...ui.state()[0], id: 'holding-2', name: '別の銘柄', symbol: 'SOXL' };
  ui.context.secondHolding = second;
  vm.runInContext('data.holdings.push(secondHolding)', ui.context);

  ui.element('#holding-symbol').value = '';
  ui.element('#holding-symbol').dataset.cleared = 'true';
  ui.element('#holding-dialog').close();
  ui.context.openHolding('holding-2');

  assert.equal(ui.element('#holding-symbol').value, 'SOXL');
  assert.equal(ui.element('#holding-symbol').dataset.cleared, undefined);
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
  assert.equal(ui.rows.has('industry'), false);
  assert.equal(ui.state()[0].auto_industry_code, 'SEMICONDUCTORS');
  assert.equal(ui.rows.get('sector').auto, null);
  ui.reset();
  assert.equal(ui.rows.get('sector').input.value, auto.auto_sector_code);
  assert.equal(ui.rows.get('sensitivity').input.value, auto.auto_sensitivity_code);
  await ui.save();
  for (const kind of ['sector', 'sensitivity']) assert.equal(ui.state()[0][`user_${kind}_code`], null);
  assert.equal(ui.state()[0].user_industry_code, undefined, 'industry remains stored but is not edited by this UI');
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
test('manual stock entry keeps null kind, and exact ETF lookup switches editor state and skips auto classification', async () => {
  const manual = setup({ existing: false, type: '米国株', currency: 'USD', symbol: 'AAPL' });
  await manual.save();
  assert.equal(manual.state()[0].instrument_kind, null);
  assert.deepEqual(manual.requests.map(([method]) => method), ['PUT', 'POST'], 'unknown stock-equivalent state still receives automatic classification');

  const equity = setup({ existing: false, type: '米国株', currency: 'USD', symbol: 'NVDA' });
  const equityFetch = equity.context.fetch;
  equity.context.fetch = async (url, options = {}) => url.startsWith('/api/name?')
    ? equity.api.response({ name: 'NVIDIA', instrument_kind: 'STOCK' })
    : equityFetch(url, options);
  await vm.runInContext('lookupHoldingName()', equity.context);
  assert.equal(equity.rows.get('sector').row.hidden, false);
  await equity.save();
  assert.equal(equity.state()[0].instrument_kind, 'STOCK');
  assert.deepEqual(equity.requests.map(([method]) => method), ['PUT', 'POST']);

  const ui = setup({ existing: false, type: '米国株', currency: 'USD', symbol: 'SOXL' });
  const fetch = ui.context.fetch;
  ui.context.fetch = async (url, options = {}) => url.startsWith('/api/name?')
    ? ui.api.response({ name: 'Direxion Semiconductor ETF', instrument_kind: 'ETF' })
    : fetch(url, options);
  await vm.runInContext('lookupHoldingName()', ui.context);
  assert.equal(ui.rows.get('sector').row.hidden, true);
  assert.equal(ui.rows.get('fundCategory').row.hidden, false);
  assert.equal(ui.rows.get('fundCategory').input.value, '');
  assert.equal(ui.rows.get('fundCategory').input.options[0].textContent, '未設定');
  assert.equal(ui.rows.get('fundCategory').reset.hidden, true);
  assert.equal(ui.rows.get('sensitivity').input.value, '');
  await ui.save();
  assert.equal(ui.state()[0].instrument_kind, 'ETF');
  assert.deepEqual(ui.requests.map(([method]) => method), ['PUT'], 'ETF does not call classification API');
  ui.context.openHolding(ui.state()[0].id);
  assert.equal(ui.rows.get('sector').row.hidden, true);
  assert.equal(ui.rows.get('fundCategory').row.hidden, false);
  assert.equal(ui.rows.get('fundCategory').reset.hidden, true);
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

const oldClassification = {
  auto_sector_code: 'FINANCIALS', auto_industry_code: 'INSURANCE', auto_sensitivity_code: 'NEUTRAL', auto_fund_category_code: 'BROAD_INDEX',
  user_sector_code: 'ENERGY', user_industry_code: 'USER_INDUSTRY', user_sensitivity_code: 'DEFENSIVE', user_fund_category_code: 'OTHER'
};
function classifiedEdit(options = {}) {
  const ui = setup(options);
  ui.context.fields = oldClassification;
  vm.runInContext('Object.assign(data.holdings[0], fields)', ui.context);
  Object.assign(ui.api.current.data.holdings[0], oldClassification);
  ui.context.openHolding('holding-1');
  const fetch = ui.context.fetch;
  ui.lookupResult = () => ui.api.response({ name: '新しい銘柄名' });
  ui.context.fetch = (url, options) => url.startsWith('/api/name?') || url.startsWith('/api/quote?') ? ui.lookupResult() : fetch(url, options);
  return ui;
}
function assertInitialClassification(ui) {
  for (const row of ui.rows.values()) assert.equal(row.input.value, '');
  assert.equal(ui.rows.has('industry'), false);
  assert.equal(ui.rows.get('sector').row.hidden, false, 'old ETF/fund flags no longer hide stock classification');
}
for (const [type, symbol, sameSymbol] of [['米国株', 'NVDA', 'nvda'], ['日本株', '8766', '8766.t']]) test(`${type} normalized-equivalent lookup keeps all classification and persisted data`, async () => {
  const ui = classifiedEdit({ type, symbol, currency: type === '日本株' ? 'JPY' : 'USD' });
  const before = ui.state();
  ui.element('#holding-symbol').value = sameSymbol;
  await ui.context.lookupHoldingName();
  for (const field of require('../classification-editor').fields.filter(field => field.kind !== 'industry')) {
    assert.equal(ui.rows.get(field.kind).input.value, oldClassification[field.user]);
  }
  assert.deepEqual(ui.state(), before);
});
test('typing a different symbol does not clear classification; successful lookup clears all eight fields only in the editor', async () => {
  const ui = classifiedEdit(); const before = ui.state();
  ui.element('#holding-symbol').value = 'MU';
  for (const field of require('../classification-editor').fields.filter(field => field.kind !== 'industry')) {
    assert.equal(ui.rows.get(field.kind).input.value, oldClassification[field.user]);
  }
  assert.deepEqual(ui.state(), before);
  await ui.context.lookupHoldingName();
  assertInitialClassification(ui);
  assert.deepEqual(ui.state(), before);
  assert.deepEqual(ui.api.current.data.holdings, before);
  assert.equal(ui.element('#holding-name').value, '新しい銘柄名');
});
for (const outcome of ['http', 'missing-name', 'exception']) test(`${outcome} lookup failure retains old classification for a different symbol`, async () => {
  const ui = classifiedEdit(); const before = ui.state();
  ui.element('#holding-symbol').value = 'MU';
  ui.lookupResult = () => outcome === 'http' ? ui.api.response({ error: 'not found' }, 404)
    : outcome === 'missing-name' ? ui.api.response({}) : Promise.reject(new Error('offline'));
  await ui.context.lookupHoldingName();
  for (const field of require('../classification-editor').fields.filter(field => field.kind !== 'industry')) {
    assert.equal(ui.rows.get(field.kind).input.value, oldClassification[field.user]);
  }
  assert.deepEqual(ui.state(), before);
});
test('saving a cleared replacement discards every old user/auto code, then classifies the new symbol', async () => {
  const ui = classifiedEdit();
  ui.element('#holding-symbol').value = 'MU';
  await ui.context.lookupHoldingName();
  ui.element('#holding-quantity').value = '3'; ui.element('#holding-cost').value = '120';
  await ui.save();
  const holding = ui.state()[0];
  assert.equal(holding.symbol, 'MU');
  assert.equal(holding.name, '新しい銘柄名');
  for (const field of classificationFields) assert.equal(holding[field], auto[field] ?? null);
  assert.deepEqual(ui.requests.map(([method]) => method), ['PUT', 'POST']);
  ui.context.openHolding('holding-1');
  assert.equal(ui.rows.get('sector').input.value, auto.auto_sector_code);
  assert.equal(ui.rows.has('industry'), false);
  assert.equal(ui.state()[0].auto_industry_code, auto.auto_industry_code);
});
test('new manual edits after classification clearing survive automatic classification, including repeated same-symbol lookups', async () => {
  const ui = classifiedEdit();
  ui.element('#holding-symbol').value = 'MU'; await ui.context.lookupHoldingName();
  ui.rows.get('sector').input.value = 'MATERIALS'; ui.rows.get('sector').input.fire('change');
  await ui.context.lookupHoldingName();
  assert.equal(ui.rows.get('sector').input.value, 'MATERIALS');
  ui.element('#holding-quantity').value = '3'; ui.element('#holding-cost').value = '120';
  await ui.save();
  assert.equal(ui.state()[0].user_sector_code, 'MATERIALS');
  assert.equal(ui.state()[0].auto_sector_code, auto.auto_sector_code);
});
test('cancelling a cleared replacement preserves original symbol and all original classifications', async () => {
  const ui = classifiedEdit(); const before = ui.state();
  ui.element('#holding-symbol').value = 'MU'; await ui.context.lookupHoldingName();
  assertInitialClassification(ui);
  ui.element('#holding-dialog').close();
  assert.deepEqual(ui.state(), before); assert.deepEqual(ui.api.current.data.holdings, before);
  assert.equal(ui.requests.length, 0);
  ui.context.openHolding('holding-1');
  assert.equal(ui.element('#holding-symbol').value, 'NVDA');
  for (const field of require('../classification-editor').fields.filter(field => field.kind !== 'industry')) {
    assert.equal(ui.rows.get(field.kind).input.value, oldClassification[field.user]);
  }
});
test('returning to the original symbol after a cleared preview restores the original classification', async () => {
  const ui = classifiedEdit(); const before = ui.state();
  ui.element('#holding-symbol').value = 'MU'; await ui.context.lookupHoldingName();
  assertInitialClassification(ui);
  ui.element('#holding-symbol').value = 'NVDA'; await ui.context.lookupHoldingName();
  for (const field of require('../classification-editor').fields.filter(field => field.kind !== 'industry')) {
    assert.equal(ui.rows.get(field.kind).input.value, oldClassification[field.user]);
  }
  assert.deepEqual(ui.state(), before);
});
test('stale lookup success cannot clear a reopened editor or a changed draft symbol', async () => {
  for (const reopen of [false, true]) {
    const ui = classifiedEdit(); const before = ui.state(); let release;
    ui.element('#holding-symbol').value = 'MU'; ui.lookupResult = () => new Promise(resolve => { release = resolve; });
    const pending = ui.context.lookupHoldingName();
    if (reopen) { ui.element('#holding-dialog').close(); ui.context.openHolding('holding-1'); }
    else ui.element('#holding-symbol').value = 'AAPL';
    release(ui.api.response({ name: 'stale name' })); await pending;
    for (const field of require('../classification-editor').fields.filter(field => field.kind !== 'industry')) {
      assert.equal(ui.rows.get(field.kind).input.value, oldClassification[field.user]);
    }
    assert.deepEqual(ui.state(), before);
  }
});
test('required stars appear on stock, fund and iDeCo quantity/cost labels without changing input rules', () => {
  for (const [type, category, quantityLabel, costLabel] of [
    ['米国株', 'specified', '保有数量 *', '取得単価 *'], ['日本株', 'specified', '保有数量 *', '取得単価 *'],
    ['投資信託', 'specified', '保有口数 *', '取得基準価額（1万口あたり） *'],
    ['投資信託', 'ideco', '保有口数 *', '取得金額（円） *']
  ]) {
    const ui = setup({ type, category, currency: type === '米国株' ? 'USD' : 'JPY', symbol: type === '投資信託' ? '03311187' : 'NVDA' });
    assert.equal(ui.element('#quantity-label').textContent, quantityLabel);
    assert.equal(ui.element('#cost-label').textContent, costLabel);
    assert.equal(ui.element('#holding-name-label').textContent, '銘柄名 *');
    assert.equal(ui.element('#holding-symbol-label').textContent,
      type === '投資信託' ? '投信コード *' : 'Yahoo Finance ティッカー *');
  }
});
