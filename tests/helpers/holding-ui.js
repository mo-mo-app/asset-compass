const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { editorRoot } = require("./classification-dom");
const root = path.resolve(__dirname, "../..");

function appContext() {
  const elements = new Map();
  const classification = editorRoot();
  const element = selector => {
    if (selector === "#holding-classifications") return classification.root;
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
    AbortSignal,
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
  vm.runInContext(fs.readFileSync(path.join(root, "classification-editor.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.indexOf('document.addEventListener("click"')), context);
  context.realPersistState = context.persistState;
  return { context, element, rows: classification.rows };
}

function prepare({ existing = true, type = "投資信託", category = "specified", currency = "JPY", quantity = 163067, cost = 16799.72, symbol = "9I311181" } = {}) {
  const { context, element, rows } = appContext();
  context.fixture = { id: "holding-1", accountId: "account-1", accountCategoryCode: category, type, currency,
    name: "元の銘柄", symbol, quantity, cost, price: 100, previousClose: 95, quoteStatus: "success", priceTimestamp: 1780000000000, priceDate: "9/30", quoteAttemptedAt: 1780000000001 };
  vm.runInContext(`data.accounts = [{ id: "account-1", name: "証券会社" }];
    data.accountCategories = ["specified", "nisa_growth", "ideco", "unassigned"].map(code => ({code, label:code}));
    data.holdings = ${existing ? "[fixture]" : "[]"}; persistState = async () => {};`, context);
  vm.runInContext("render = () => {};", context);
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
  return { context, element, rows,
    save: () => element("#holding-form").eventHandlers.submit({preventDefault(){}}),
    state: () => JSON.parse(vm.runInContext("JSON.stringify(data.holdings)",context)) };
}
module.exports = { prepare };
