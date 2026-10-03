const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function appContext() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: "",
      textContent: "",
      innerHTML: "",
      placeholder: "",
      hidden: false,
      disabled: false,
      dataset: {},
      children: [],
      options: [],
      style: { setProperty() {} },
      attributes: new Map(),
      eventHandlers: {},
      setAttribute(name, value) { this.attributes.set(name, value); },
      replaceChildren(...children) { this.children = children; this.options = children; this.innerHTML = ""; },
      add(option) { this.options.push(option); },
      addEventListener(name, handler) { this.eventHandlers[name] = handler; },
      reset() {
        for (const id of ["#holding-id", "#holding-name", "#holding-symbol", "#holding-quantity", "#holding-cost"]) element(id).value = "";
        element("#holding-type").value = "日本株";
        element("#holding-currency").value = "JPY";
      },
      showModal() { this.open = true; },
      close() { this.open = false; this.eventHandlers.close?.({ target: this }); }
    });
    return elements.get(selector);
  };
  function Option(label, value) { this.textContent = label; this.value = value; }
  const context = vm.createContext({
    Intl,
    console,
    fetch: async () => { throw new Error("offline"); },
    window: { innerWidth: 1280 },
    localStorage: { getItem: () => JSON.stringify({ accounts: [], holdings: [] }) },
    document: {
      querySelector: element,
      createElement: () => ({ textContent: "", get innerHTML() { return this.textContent; } })
    },
    Option
  });
  vm.runInContext(fs.readFileSync(path.join(root, "symbols.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "holding-number-rules.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "classification-masters.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "classification-display.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener("click"')), context);
  return { context, element };
}

function prepare({ existing = true, type = "投資信託", category = "specified", currency = "JPY", quantity = 163067, cost = 16799.72, symbol = "9I311181" } = {}) {
  const { context, element } = appContext();
  context.fixture = { id: "holding-1", accountId: "account-1", accountCategoryCode: category, type, currency,
    name: "元の銘柄", symbol, quantity, cost, price: 100, previousClose: 95, quoteStatus: "success", priceTimestamp: 1780000000000, priceDate: "9/30", quoteAttemptedAt: 1780000000001 };
  vm.runInContext(`data.accounts = [{ id: "account-1", name: "証券会社" }];
    data.accountCategories = ["specified", "nisa_growth", "ideco", "unassigned"].map(code => ({code, label:code}));
    data.holdings = ${existing ? "[fixture]" : "[]"}; persistState = async () => {};`, context);
  context.openHolding(existing ? "holding-1" : "");
  if (!existing) {
    element("#holding-account").value = "account-1";
    element("#holding-type").value = type;
    element("#holding-account-category").value = category;
    element("#holding-currency").value = currency;
    element("#holding-symbol").value = symbol;
    element("#holding-name").value = "新しい銘柄";
    element("#holding-quantity").value = String(quantity);
    element("#holding-cost").value = String(cost);
    context.updateHoldingFormLabels(); context.rememberHoldingClassification();
  }
  const source = fs.readFileSync(path.join(root,"app.js"),"utf8");
  const start = source.indexOf('$("#holding-form").addEventListener("submit",async e=>{');
  const end = source.indexOf('$("#account-form").addEventListener("submit"', start);
  vm.runInContext(source.slice(start,end), context);
  const eventsStart = source.indexOf('$("#filter-account").addEventListener');
  vm.runInContext(source.slice(eventsStart,source.indexOf('$("#trend-detail-account").addEventListener',eventsStart)),context);
  return { context, element,
    save: () => element("#holding-form").eventHandlers.submit({preventDefault(){}}),
    state: () => JSON.parse(vm.runInContext("JSON.stringify(data.holdings)",context)) };
}
function assertCleared(element) {
  assert.equal(element("#holding-quantity").value, "");
  assert.equal(element("#holding-cost").value, "");
  assert.match(element("#holding-input-error").textContent,/クリア/);
}
function assertAssetCategoryInputsCleared(element) {
  assert.equal(element("#holding-name").value, "");
  assert.equal(element("#holding-symbol").value, "");
  assertCleared(element);
}

test("normal fund and iDeCo changes clear quantity and cost instead of converting, for new and existing holdings", () => {
  for (const existing of [false,true]) for (const category of ["specified","ideco"]) {
    const {element,state} = prepare({existing,category});
    const savedBefore = state();
    element("#holding-account-category").value = category === "ideco" ? "specified" : "ideco";
    element("#holding-account-category").eventHandlers.change();
    assertAssetCategoryInputsCleared(element);
    assert.equal(element("#holding-type").value,"投資信託");
    assert.deepEqual(state(), savedBefore, "unsubmitted edit must not modify the saved holding");
  }
});
test("all asset type transitions clear the name, code, quantity and cost in new and edit forms", () => {
  for (const existing of [false,true]) for (const from of ["日本株","米国株","投資信託"]) for (const to of ["日本株","米国株","投資信託"]) {
    if (from===to) continue;
    const {element,state} = prepare({existing,type:from});
    const savedBefore = state();
    element("#holding-type").value=to;
    element("#holding-type").eventHandlers.change();
    assertAssetCategoryInputsCleared(element);
    assert.deepEqual(state(), savedBefore, "unsubmitted edit must not modify the saved holding");
  }
});
test("broker-only and non-iDeCo category changes retain numeric inputs", () => {
  const {element}=prepare();
  const q=element("#holding-quantity").value, c=element("#holding-cost").value;
  element("#holding-account").value="another-account";
  element("#holding-account").eventHandlers.change();
  for (const category of ["nisa_growth","specified"]) {
    element("#holding-account-category").value=category;
    element("#holding-account-category").eventHandlers.change();
    assert.equal(element("#holding-quantity").value,q); assert.equal(element("#holding-cost").value,c);
  }
});
test("currency change preserves quantity but clears cost", () => {
  const {element}=prepare({type:"米国株",currency:"USD"});
  const q=element("#holding-quantity").value;
  element("#holding-currency").value="JPY";
  element("#holding-currency").eventHandlers.change();
  assert.equal(element("#holding-quantity").value,q); assert.equal(element("#holding-cost").value,"");
});
test("classification changes cannot generate values from blank, zero or malformed quantities", () => {
  for (const quantity of ["", "0", "invalid"]) {
    const {element}=prepare(); element("#holding-quantity").value=quantity;
    element("#holding-account-category").value="ideco";
    element("#holding-account-category").eventHandlers.change();
    assertCleared(element);
    assert.equal(element("#holding-cost-calculated").textContent,"取得単価（自動計算）：—");
  }
});
test("blank values remain blank and non-fund to iDeCo fixes type without conversion", () => {
  const {element}=prepare({type:"日本株"});
  element("#holding-quantity").value=""; element("#holding-cost").value="";
  element("#holding-account-category").value="ideco";
  element("#holding-account-category").eventHandlers.change();
  assertCleared(element); assert.equal(element("#holding-type").value,"投資信託");
});
test("opening an existing iDeCo holding restores integer yen without modifying its stored cost", async () => {
  const {context,element,state,save}=prepare({category:"ideco"});
  assert.equal(element("#holding-cost").value,"273,948");
  assert.equal(state()[0].cost,16799.72);
  assert.equal(context.normalizeIdecoAcquisitionAmount(273947.99999999994),273948);
  await save();
  assert.equal(state()[0].cost,273948/163067*10000);
  assert.equal(element("#holding-cost-calculated").textContent,"取得単価（自動計算）：16,799.72円");
});
test("new iDeCo saving derives full-precision cost from integer yen", async () => {
  const {element,save,state}=prepare({existing:false,category:"ideco",cost:273948});
  element("#holding-cost").value="273,948"; await save();
  assert.equal(state()[0].cost,273948/163067*10000);
});
test("fractional iDeCo acquisition amount is rejected at blur and save without rounding", async () => {
  const {element,save,state}=prepare({existing:false,category:"ideco",cost:273948.5});
  element("#holding-cost").eventHandlers.blur();
  assert.equal(element("#holding-cost").value,"273948.5");
  assert.match(element("#holding-input-error").textContent,/取得金額は1円単位/);
  await save(); assert.equal(state().length,0);
  assert.equal(element("#holding-cost-calculated").textContent,"取得単価（自動計算）：—");
});
test("save revalidates all numeric fields without requiring blur", async () => {
  for (const [type,currency,field,value] of [
    ["日本株","JPY","quantity","100.5"], ["日本株","JPY","cost","123.456"],
    ["米国株","USD","quantity","1.12345"], ["米国株","USD","cost","123.45678"],
    ["米国株","JPY","cost","123.456"], ["投資信託","JPY","quantity","10000.5"],
    ["投資信託","JPY","cost","16799.72"], ["日本株","JPY","quantity","1,,234"],
    ["日本株","JPY","cost",""]]) {
    const {element,save,state}=prepare({existing:false,type,currency,cost:10000,quantity:100,symbol:type==="投資信託"?"9I311181":"ABC"});
    element("#holding-"+field).value=value; await save();
    assert.equal(state().length,0, type+" "+field+" "+value);
    assert.equal(element("#holding-input-error").hidden,false);
  }
});

test("field errors stay independent until that field is corrected", async () => {
  const {element}=prepare({existing:false,type:"米国株",currency:"USD",quantity:1,cost:100,symbol:"AAPL"});
  const quantity=element("#holding-quantity"), cost=element("#holding-cost"), message=element("#holding-input-error");
  quantity.value="1.12345"; quantity.eventHandlers.blur();
  assert.equal(quantity.dataset.invalid,"true");
  cost.value="100"; cost.eventHandlers.blur();
  assert.equal(quantity.dataset.invalid,"true");
  assert.match(message.textContent,/保有数量は小数4桁まで/);
  quantity.value="1.1234"; quantity.eventHandlers.input();
  assert.equal(quantity.dataset.invalid,undefined);
  assert.equal(message.hidden,true);

  cost.value="100.12345"; cost.eventHandlers.blur();
  assert.equal(cost.dataset.invalid,"true");
  quantity.value="2"; quantity.eventHandlers.blur();
  assert.equal(cost.dataset.invalid,"true");
  assert.match(message.textContent,/取得単価は小数4桁まで/);
  cost.value="100.1234"; cost.eventHandlers.input();
  assert.equal(cost.dataset.invalid,undefined);
  assert.equal(message.hidden,true);
});

test("save marks both invalid fields; classification clear and reopening reset errors", async () => {
  const {context,element,save}=prepare({existing:false,type:"米国株",currency:"USD",quantity:1,cost:100,symbol:"AAPL"});
  const quantity=element("#holding-quantity"), cost=element("#holding-cost"), message=element("#holding-input-error");
  quantity.value="1.12345"; cost.value="100.12345";
  await save();
  assert.equal(quantity.dataset.invalid,"true"); assert.equal(cost.dataset.invalid,"true");
  assert.match(message.textContent,/保有数量は小数4桁まで/); assert.match(message.textContent,/取得単価は小数4桁まで/);
  element("#holding-type").value="投資信託"; element("#holding-type").eventHandlers.change();
  assert.equal(quantity.dataset.invalid,undefined); assert.equal(cost.dataset.invalid,undefined);
  assert.equal(message.textContent.includes("小数"),false);
  element("#holding-dialog").close(); context.openHolding("");
  assert.equal(quantity.dataset.invalid,undefined); assert.equal(cost.dataset.invalid,undefined);
  assert.equal(message.hidden,true);
});
test("blur formats valid inputs while malformed commas are preserved on focus and blur", () => {
  const {element}=prepare({existing:false,type:"米国株",currency:"USD"});
  for (const [value,expected] of [["1.","1"],[".5","0.5"],["1.2300","1.23"],["1,234.50","1,234.5"]]) {
    element("#holding-cost").value=value; element("#holding-cost").eventHandlers.blur();
    assert.equal(element("#holding-cost").value,expected);
  }
  element("#holding-cost").value="12,34"; element("#holding-cost").eventHandlers.focus(); element("#holding-cost").eventHandlers.blur();
  assert.equal(element("#holding-cost").value,"12,34"); assert.equal(element("#holding-input-error").hidden,false);
});
test("unchanged legacy numbers survive opening, blur and edits to another field", async () => {
  const {element,save,state}=prepare({type:"米国株",currency:"USD",quantity:1.123456,cost:12.123456,symbol:"AAPL"});
  assert.equal(element("#holding-quantity").value,"1.123456");
  element("#holding-quantity").eventHandlers.blur(); element("#holding-cost").eventHandlers.blur();
  element("#holding-name").value="別の表示名"; await save();
  assert.equal(state()[0].quantity,1.123456); assert.equal(state()[0].cost,12.123456);
});
test("changed legacy values must obey new precision rules, even if Number would round them to the old value", async () => {
  const {element,save,state}=prepare({type:"米国株",currency:"USD",quantity:1.123456,cost:12,symbol:"AAPL"});
  for (const value of ["1.12345","1.123456000000000000001"]) {
    element("#holding-quantity").value=value; await save(); assert.equal(state()[0].quantity,1.123456);
    assert.equal(element("#holding-input-error").hidden,false);
  }
  element("#holding-quantity").value="1.1234"; await save(); assert.equal(state()[0].quantity,1.1234);
});
test("legacy exponent-form numbers are expanded for editing without changing stored values", async () => {
  const {element,save,state}=prepare({type:"米国株",currency:"USD",quantity:1e-7,cost:1e21,symbol:"AAPL"});
  assert.equal(element("#holding-quantity").value,"0.0000001");
  assert.equal(element("#holding-cost").value,"1,000,000,000,000,000,000,000");
  await save(); assert.equal(state()[0].quantity,1e-7); assert.equal(state()[0].cost,1e21);
});
test("PC, mobile and TOP quantities retain the same decimals including legacy values", () => {
  const {context}=prepare({type:"米国株",currency:"USD",symbol:"AAPL"});
  for (const quantity of [1.1234,1.123456,163067]) {
    const holding={...context.fixture,quantity}; const text=String(quantity===163067?"163,067":quantity);
    const row=context.holdingRow(holding);
    assert.ok(row.includes('<span class="money">'+text+' 株</span>'));
    assert.ok(row.includes('<span>'+text+'</span>'));
    assert.ok(context.dashboardHoldingRow(holding).includes(text+' 株'));
  }
});
test("symbol typing does not clear fields, normalized equivalent codes do not trigger a change", async () => {
  const {element,save,state}=prepare({type:"日本株",quantity:100,cost:123.45,symbol:"563A"});
  element("#holding-symbol").value="7203"; assert.equal(element("#holding-quantity").value,"100");
  element("#holding-symbol").value="563a.t"; await save(); assert.equal(state()[0].quantity,100); assert.equal(state()[0].price,100);
});
test("equivalent US symbol case preserves existing prices and numeric inputs", async () => {
  const {element,save,state}=prepare({type:"米国株",currency:"USD",quantity:2,cost:123,symbol:"aapl"});
  element("#holding-symbol").value="AAPL"; await save();
  assert.equal(state()[0].quantity,2); assert.equal(state()[0].price,100);
});
test("new symbol without lookup aborts once, clears old fields and resets quote data only on actual save", async () => {
  const {element,save,state}=prepare({type:"米国株",currency:"USD",quantity:2,cost:123,symbol:"AAPL"});
  element("#holding-symbol").value="MSFT"; await save();
  assertCleared(element); assert.equal(element("#holding-name").value,""); assert.equal(state()[0].symbol,"AAPL");
  element("#holding-name").value="Microsoft"; element("#holding-quantity").value="3.1234"; element("#holding-cost").value="200.1234"; await save();
  assert.equal(state()[0].symbol,"MSFT"); assert.equal(state()[0].quantity,3.1234);
  for(const field of ["price","previousClose","priceTimestamp","priceDate","quoteAttemptedAt"]) assert.equal(state()[0][field],null);
  assert.equal(state()[0].quoteStatus,"unknown");
});
test("successful different-symbol lookup clears numbers, applies only the new name and permits reentry", async () => {
  const {context,element,save,state}=prepare({type:"米国株",currency:"USD",quantity:2,cost:123,symbol:"AAPL"});
  element("#holding-symbol").value="MSFT";
  context.fetch=async()=>({ok:true,json:async()=>({name:"Microsoft"})});
  await context.lookupHoldingName(); assertCleared(element); assert.equal(element("#holding-name").value,"Microsoft");
  element("#holding-quantity").value="3"; element("#holding-cost").value="200"; await save(); assert.equal(state()[0].name,"Microsoft");
});

test("new holding keeps initial edits, then clears values when its confirmed symbol changes", async () => {
  const {context,element,save,state}=prepare({existing:false,type:"米国株",currency:"USD",quantity:10,cost:150,symbol:"NVDA"});
  context.fetch=async()=>({ok:true,json:async()=>({name:"NVIDIA"})});
  await context.lookupHoldingName();
  assert.equal(element("#holding-quantity").value,"10");
  assert.equal(element("#holding-cost").value,"150");
  element("#holding-quantity").value="10"; element("#holding-cost").value="150";
  element("#holding-symbol").value="AAPL";
  context.fetch=async()=>({ok:true,json:async()=>({name:"Apple"})});
  await context.lookupHoldingName();
  assert.equal(element("#holding-name").value,"Apple");
  assert.equal(element("#holding-quantity").value,""); assert.equal(element("#holding-cost").value,"");
  assert.match(element("#holding-input-error").textContent,/銘柄が変更されたため/);
  element("#holding-quantity").value="2"; element("#holding-cost").value="100";
  await save();
  assert.equal(state()[0].symbol,"AAPL"); assert.equal(state()[0].quantity,2); assert.equal(state()[0].cost,100);
});

test("new holding code edits before its first successful lookup do not clear entered values", async () => {
  const {context,element}=prepare({existing:false,type:"米国株",currency:"USD",quantity:10,cost:150,symbol:"NVDA"});
  element("#holding-symbol").value="AAPL";
  context.fetch=async()=>({ok:true,json:async()=>({name:"Apple"})});
  await context.lookupHoldingName();
  assert.equal(element("#holding-name").value,"Apple");
  assert.equal(element("#holding-quantity").value,"10");
  assert.equal(element("#holding-cost").value,"150");
});

test("new holding treats normalized-equivalent confirmed stock symbols as the same identity", async () => {
  const {context,element}=prepare({existing:false,type:"日本株",currency:"JPY",quantity:10,cost:150,symbol:"563A"});
  context.fetch=async()=>({ok:true,json:async()=>({name:"銘柄名"})});
  await context.lookupHoldingName();
  element("#holding-symbol").value="563a.t";
  await context.lookupHoldingName();
  assert.equal(element("#holding-quantity").value,"10");
  assert.equal(element("#holding-cost").value,"150");
});

test("new holding symbol change without lookup clears once, then saves after re-entry", async () => {
  const {context,element,save,state}=prepare({existing:false,type:"米国株",currency:"USD",quantity:10,cost:150,symbol:"NVDA"});
  context.fetch=async()=>({ok:true,json:async()=>({name:"NVIDIA"})});
  await context.lookupHoldingName();
  element("#holding-symbol").value="MSFT";
  await save();
  assert.equal(state().length,0);
  assert.equal(element("#holding-name").value,"");
  assert.equal(element("#holding-quantity").value,"");
  assert.equal(element("#holding-cost").value,"");
  element("#holding-name").value="Microsoft";
  element("#holding-quantity").value="3";
  element("#holding-cost").value="200";
  await save();
  assert.equal(state()[0].symbol,"MSFT");
  assert.equal(state()[0].quantity,3);
  assert.equal(state()[0].cost,200);
});
test("lookup disables both controls and always restores them on success, API failure and exceptions", async () => {
  for(const outcome of ["success","failure","exception"]) {
    const {context,element}=prepare(); let resolve;
    context.fetch=()=>new Promise(r=>resolve=r);
    const pending=context.lookupHoldingName();
    assert.equal(element("#holding-symbol").disabled,true); assert.equal(element("#lookup-name").disabled,true);
    assert.equal(element("#name-lookup-status").textContent,"取得中…");
    resolve({ok:outcome!=="failure",json:async()=>{if(outcome==="exception")throw new Error("bad JSON"); return {name:"新しい名前",error:"failed"};}});
    await pending;
    assert.equal(element("#holding-symbol").disabled,false); assert.equal(element("#lookup-name").disabled,false);
    assert.equal(element("#holding-name").value,outcome==="success"?"新しい名前":"元の銘柄");
  }
});
test("stale lookup responses and responses belonging to a reopened form cannot alter current fields", async () => {
  for(const reopen of [false,true]) {
    const {context,element}=prepare(); let resolve;
    context.fetch=()=>new Promise(r=>resolve=r); const pending=context.lookupHoldingName();
    if(reopen)context.openHolding("holding-1"); else element("#holding-symbol").value="NEWCODE1";
    resolve({ok:true,json:async()=>({name:"古いレスポンス"})}); await pending;
    assert.equal(element("#holding-name").value,"元の銘柄");
    assert.equal(element("#holding-symbol").disabled,false); assert.equal(element("#lookup-name").disabled,false);
  }
});

test("lookup responses after closing a form are discarded and cannot affect a subsequent holding", async () => {
  const {context,element}=prepare(); let resolve;
  context.fetch=()=>new Promise(r=>resolve=r);
  const pending=context.lookupHoldingName();
  vm.runInContext('data.holdings.push({...fixture,id:"holding-2",name:"別の銘柄",symbol:"MSFT"})',context);
  element("#holding-dialog").close();
  assert.equal(element("#holding-symbol").disabled,false);
  assert.equal(element("#lookup-name").disabled,false);
  context.openHolding("holding-2");
  resolve({ok:true,json:async()=>({name:"古いレスポンス"})});
  await pending;
  assert.equal(element("#holding-name").value,"別の銘柄");
  assert.equal(element("#holding-symbol").value,"MSFT");
  assert.equal(element("#holding-quantity").value,"163,067");
});
test("network exceptions restore both lookup controls and saving during lookup is blocked", async () => {
  const {context,element,save,state}=prepare({type:"米国株",currency:"USD",quantity:2,cost:123,symbol:"AAPL"});
  let reject;
  context.fetch=()=>new Promise((resolve, fail)=>reject=fail);
  const pending=context.lookupHoldingName();
  element("#holding-quantity").value="3"; await save();
  assert.equal(state()[0].quantity,2); assert.match(element("#holding-input-error").textContent,/取得が完了/);
  reject(new Error("offline")); await pending;
  assert.equal(element("#holding-symbol").disabled,false); assert.equal(element("#lookup-name").disabled,false);
  assert.match(element("#name-lookup-status").textContent,/offline/);
});
