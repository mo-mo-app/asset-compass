const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const editor = require("../classification-editor");
const masters = require("../classification-masters");

// Only DOM operations used by the editor; real browser layout is checked separately.
function element() {
  return { value: "", textContent: "", dataset: {}, hidden: false, disabled: false, handlers: {}, options: [],
    addEventListener(type, fn) { this.handlers[type] = fn; },
    replaceChildren(...options) { this.options = options; },
    fire(type) { this.handlers[type]?.({ target: this }); } };
}
function editorRoot() {
  const rows = new Map(editor.fields.map(field => {
    const controls = { input: element(), status: field.kind === "fundCategory" ? element() : null, auto: field.kind === "fundCategory" ? element() : null, reset: element() };
    const row = { hidden: false, querySelector(selector) { return controls[{
      "input, select": "input", ".classification-status": "status", ".classification-auto": "auto", ".classification-reset": "reset"
    }[selector]]; } };
    return [field.kind, { ...controls, row }];
  }));
  const help = element();
  const root = { innerHTML: "", ownerDocument: { createElement: element },
    querySelector(selector) {
      return selector === "#classification-industry-help" ? help : rows.get(selector.match(/"([^"]+)"/)[1]).row;
    } };
  return { root, rows, help };
}
const stock = { type: "米国株", auto_sector_code: "INFORMATION_TECHNOLOGY", auto_industry_code: "SEMICONDUCTORS",
  auto_sensitivity_code: "CYCLICAL", user_sector_code: "FINANCIALS", user_industry_code: "USER_INDUSTRY", user_sensitivity_code: "DEFENSIVE" };

test("editor shows user priority without duplicate classification descriptions or overrides on open", () => {
  const { root, rows } = editorRoot(), ui = editor.createEditor(root);
  const before = structuredClone(stock);
  ui.open(stock, stock.type);
  assert.equal(rows.get("sector").input.value, "FINANCIALS");
  assert.doesNotMatch(root.innerHTML, /classification-(sector|industry|sensitivity)-status/);
  assert.equal(rows.get("sector").auto, null);
  assert.equal(rows.get("industry").input.value, "USER_INDUSTRY");
  assert.equal(rows.get("sensitivity").input.value, "DEFENSIVE");
  assert.deepEqual(ui.getPatch(), {});
  assert.deepEqual(stock, before);
});

test("select/input edits produce only user fields, and each reset restores the automatic display immediately", () => {
  const { root, rows } = editorRoot(), ui = editor.createEditor(root);
  ui.open(stock, stock.type);
  for (const [kind, value] of [["sector", "ENERGY"], ["industry", "SOFTWARE_INFRASTRUCTURE"], ["sensitivity", "NEUTRAL"]]) {
    rows.get(kind).input.value = value;
    rows.get(kind).input.fire(kind === "industry" ? "input" : "change");
  }
  assert.deepEqual(ui.getPatch(), { user_sector_code: "ENERGY", user_industry_code: "SOFTWARE_INFRASTRUCTURE", user_sensitivity_code: "NEUTRAL" });
  for (const kind of ["sector", "industry", "sensitivity"]) rows.get(kind).reset.fire("click");
  assert.deepEqual(ui.getPatch(), { user_sector_code: null, user_industry_code: null, user_sensitivity_code: null });
  for (const field of editor.fields.filter(field => field.group !== "fund")) {
    const node = rows.get(field.kind);
    assert.equal(node.input.value, stock[field.auto]);
    assert.equal(node.reset.disabled, true);
  }
  ui.open({ type: "投資信託", auto_fund_category_code: "BROAD_INDEX", user_fund_category_code: "HIGH_DIVIDEND" }, "投資信託");
  rows.get("fundCategory").reset.fire("click");
  assert.deepEqual(ui.getPatch(), { user_fund_category_code: null });
  assert.equal(rows.get("fundCategory").input.value, "BROAD_INDEX");
});

test("stock, fund and existing ETF category codes select the applicable fields without any ETF toggle or inference", () => {
  const { root, rows, help } = editorRoot(), ui = editor.createEditor(root);
  for (const [holding, type, fund] of [
    [{}, "日本株", false], [{}, "米国株", false], [{}, "投資信託", true],
    [{ auto_fund_category_code: "BROAD_INDEX" }, "米国株", true],
    [{ user_fund_category_code: "REIT" }, "日本株", true],
    [{ symbol: "VOO", auto_fund_category_code: null, user_fund_category_code: null }, "米国株", false]
  ]) {
    ui.open(holding, type);
    assert.equal(rows.get("sector").row.hidden, fund);
    assert.equal(rows.get("industry").input.disabled, fund);
    assert.equal(rows.get("fundCategory").row.hidden, !fund);
    assert.equal(rows.get("sensitivity").row.hidden, false);
    assert.match(help.textContent, type === "日本株" ? /東証33業種/ : /空欄で自動分類/);
    assert.doesNotMatch(help.textContent, /米国株は取得元/);
  }
  assert.doesNotMatch(root.innerHTML, /holding-classification-kind/);
  ui.open(stock, "米国株");
  rows.get("sector").input.value = "ENERGY"; rows.get("sector").input.fire("change");
  ui.setType("投資信託");
  assert.deepEqual(ui.getPatch(), {}, "hidden fields must not be submitted");
  ui.setType("日本株");
  assert.deepEqual(ui.getPatch(), { user_sector_code: "ENERGY" });
});

test("unknown existing codes remain visible and unchanged; new invalid edits are rejected", () => {
  const { root, rows } = editorRoot(), ui = editor.createEditor(root);
  ui.open({ ...stock, user_sector_code: "legacy_sector" }, "米国株");
  assert.equal(rows.get("sector").input.value, "legacy_sector");
  assert.ok(rows.get("sector").input.options.some(option => option.value === "legacy_sector"));
  assert.deepEqual(ui.getPatch(), {});
  rows.get("sector").input.value = "not_a_sector"; rows.get("sector").input.fire("change");
  assert.throws(() => ui.getPatch(), /不正/);
  ui.open(stock, "米国株");
  rows.get("industry").input.value = "業種名"; rows.get("industry").input.fire("input");
  assert.throws(() => ui.getPatch(), /不正/);
  rows.get("industry").input.value = ""; rows.get("industry").input.fire("input");
  assert.deepEqual(ui.getPatch(), { user_industry_code: null });
});

test("saving omits every automatic field without mutating cache data or user overrides", () => {
  const data = { accounts: [], holdings: [{ ...stock, auto_fund_category_code: null, user_fund_category_code: null }], usdJpyRate: 150 };
  const before = structuredClone(data), save = editor.toSaveData(data);
  for (const field of editor.fields) {
    assert.equal(Object.hasOwn(save.holdings[0], field.auto), false);
    assert.equal(save.holdings[0][field.user], data.holdings[0][field.user]);
  }
  assert.deepEqual(data, before);
});

test("editing API validator rejects auto changes and validates masters while preserving unchanged legacy values", () => {
  for (const field of editor.fields) {
    assert.throws(() => editor.assertEditableClassification({ ...stock, [field.auto]: "OTHER" }, stock), /自動分類/);
    assert.equal(editor.validateUserCode(field.kind, null), true);
  }
  for (const kind of ["sector", "sensitivity", "fundCategory"]) {
    for (const value of ["INVALID_CODE", "", false, 42, "information_technology"]) assert.equal(editor.validateUserCode(kind, value), false);
  }
  for (const value of ["SEMICONDUCTORS\n", "INSURANCE\r", " industry", "業種名", "", null]) {
    assert.equal(editor.validateUserCode("industry", value), value === null);
  }
  const legacy = { user_sector_code: "old_sector", auto_sector_code: "old_auto" };
  editor.assertEditableClassification(legacy, legacy);
  editor.assertEditableClassification({ ...stock, user_sector_code: null }, stock);
  assert.throws(() => editor.assertEditableClassification({ type: "投資信託", user_sector_code: "ENERGY" }), /投資信託/);
});

test("holding form submit merges only editor user patch, keeps automatic codes, and leaves the dialog open on validation errors", async () => {
  const elements = new Map(), el = selector => {
    if (!elements.has(selector)) elements.set(selector, { ...element(), dataset: {}, close() { this.closed = true; } });
    return elements.get(selector);
  };
  const context = vm.createContext({ document: { querySelector: el }, AssetCompassSymbols: require("../symbols"),
    localStorage: { getItem: () => null }, window: {}, Intl,
    fixture: { id: "h", accountId: "a", accountCategoryCode: "specified", currency: "USD", symbol: "NVDA", name: "NVDA", quantity: 1, cost: 100, ...stock }, patch: { user_sector_code: "ENERGY" } });
  const source = fs.readFileSync(path.resolve(__dirname, "../app.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf("function showSyncNotice")), context);
  vm.runInContext(`let holdingClassificationEditor = { getPatch: () => patch, open() {} }; let holdingFieldErrors = {};
    let holdingSaveInProgress = false; let holdingEditState = { original: fixture };
    function holdingDraftFingerprint() { return JSON.stringify(patch); }
    async function completeHoldingClassification() {}
    function needsAutomaticClassification() { return false; }
    data = { accounts: [], holdings: [fixture] };
    function isIdecoCategory() { return false; } function confirmHoldingSymbolChange() { return false; }
    function validateHoldingField(field) { return { value: field === 'quantity' ? 1 : 100 }; }
    function formatHoldingNumericField() {} function showHoldingInputError(error) { errorMessage = error; }
    function setHoldingFieldError() {} async function persistState() { saved = true; }`, context);
  for (const [selector, value] of [["id", "h"], ["account", "a"], ["account-category", "specified"], ["type", "米国株"], ["currency", "USD"], ["name", "NVDA"], ["symbol", "NVDA"]]) el(`#holding-${selector}`).value = value;
  el("#holding-dialog").open = true;
  vm.runInContext(source.slice(source.indexOf("function sameHoldingIdentity("), source.indexOf("function confirmHoldingSymbolChange(")), context);
  const start = source.indexOf('$("#holding-form").addEventListener("submit",async e=>{');
  vm.runInContext(source.slice(start, source.indexOf('$("#account-form").addEventListener', start)), context);
  await el("#holding-form").handlers.submit({ preventDefault() {} });
  const saved = JSON.parse(vm.runInContext("JSON.stringify(data.holdings[0])", context));
  assert.equal(saved.user_sector_code, "ENERGY");
  for (const field of editor.fields) assert.equal(saved[field.auto], stock[field.auto]);
  assert.equal(el("#holding-dialog").closed, true);
  el("#holding-dialog").closed = false;
  vm.runInContext('holdingClassificationEditor.getPatch = () => { throw new Error("分類コードが不正です"); }; saved = false;', context);
  await el("#holding-form").handlers.submit({ preventDefault() {} });
  assert.equal(context.saved, false);
  assert.equal(el("#holding-dialog").closed, false);
  assert.match(context.errorMessage, /不正/);
  assert.equal(masters.getEffectiveCode(saved, "sector"), "ENERGY");
});

test("new stock classification defaults to automatic selects and an empty industry with an automatic placeholder", () => {
  const { root, rows } = editorRoot(), ui = editor.createEditor(root);
  for (const type of ['米国株', '日本株']) {
    ui.open(null, type);
    for (const kind of ['sector', 'sensitivity']) {
      assert.equal(rows.get(kind).input.value, '');
      assert.equal(rows.get(kind).input.options[0].textContent, '自動分類を使用');
      assert.equal(rows.get(kind).input.options[0].value, '');
    }
    assert.equal(rows.get('industry').input.value, '');
    assert.match(root.innerHTML, /id="classification-industry" placeholder="自動分類を使用"/);
    assert.deepEqual(ui.getPatch(), {});
  }
});

test("reopening selects user then auto then automatic-use fallback for each stock classification field", () => {
  const { rows, root } = editorRoot(), ui = editor.createEditor(root);
  for (const fields of [stock, { ...stock, user_sector_code: null, user_industry_code: null, user_sensitivity_code: null },
    { type: '米国株', user_sector_code: null, auto_sector_code: null, user_industry_code: null, auto_industry_code: null }]) {
    const before = structuredClone(fields);
    ui.open(fields, '米国株');
    for (const field of editor.fields.filter(field => field.group !== 'fund')) {
      assert.equal(rows.get(field.kind).input.value, fields[field.user] ?? fields[field.auto] ?? '');
    }
    assert.deepEqual(ui.getPatch(), {});
    assert.deepEqual(fields, before);
  }
});
