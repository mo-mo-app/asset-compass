const editor = require("../../classification-editor");
function element() {
  return { value: "", textContent: "", dataset: {}, hidden: false, disabled: false, handlers: {}, options: [],
    addEventListener(type, fn) { this.handlers[type] = fn; },
    replaceChildren(...options) { this.options = options; },
    fire(type) { this.handlers[type]?.({ target: this }); } };
}
function editorRoot() {
  const rows = new Map(editor.fields.map(field => {
    const controls = { input: element(), status: element(), auto: element(), reset: element() };
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
module.exports = { editorRoot };
