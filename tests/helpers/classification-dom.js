const editor = require("../../classification-editor");
function element() {
  return { value: "", textContent: "", dataset: {}, hidden: false, disabled: false, handlers: {}, options: [],
    addEventListener(type, fn) { this.handlers[type] = fn; },
    replaceChildren(...options) { this.options = options; },
    fire(type) { this.handlers[type]?.({ target: this }); } };
}
function editorRoot() {
  const rows = new Map(editor.fields.filter(field => field.kind !== "industry").map(field => {
    const controls = { input: element(), status: null, auto: null, reset: element() };
    const row = { hidden: false, querySelector(selector) { return controls[{
      "input, select": "input", ".classification-reset": "reset"
    }[selector]]; } };
    return [field.kind, { ...controls, row }];
  }));
  const root = { innerHTML: "", ownerDocument: { createElement: element },
    querySelector(selector) {
      return rows.get(selector.match(/"([^"]+)"/)[1]).row;
    } };
  return { root, rows };
}
module.exports = { editorRoot };
