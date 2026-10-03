(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./classification-masters"));
  else root.AssetCompassClassificationEditor = factory(root.AssetCompassClassificationMasters);
})(globalThis, function (masters) {
  const fields = Object.freeze([
    { kind: "sector", suffix: "sector", label: "セクター", master: "sectors", group: "stock" },
    { kind: "industry", suffix: "industry", label: "業種コード", group: "stock" },
    { kind: "fundCategory", suffix: "fund_category", label: "ファンドカテゴリ", master: "fundCategories", group: "fund" },
    { kind: "sensitivity", suffix: "sensitivity", label: "景気感応度", master: "sensitivities", group: "both" }
  ].map(field => Object.freeze({ ...field, user: `user_${field.suffix}_code`, auto: `auto_${field.suffix}_code` })));

  function validateUserCode(kind, code) {
    if (code === null) return true;
    if (kind === "industry") return typeof code === "string" && code.length > 0 && code.length <= 128 && !/[^A-Za-z0-9_.:-]/.test(code);
    return masters.getEntry(kind, code) !== null;
  }
  function assertEditableClassification(next, previous = {}) {
    for (const field of fields) {
      if ((next[field.auto] ?? null) !== (previous[field.auto] ?? null)) {
        throw new Error(`${field.auto}: 自動分類は編集できません。`);
      }
      const value = next[field.user] ?? null;
      // Preserve legacy/unknown codes when untouched, but never accept new invalid values.
      if (value !== (previous[field.user] ?? null) && !validateUserCode(field.kind, value)) {
        throw new Error(`${field.user}: 分類コードが不正です。`);
      }
      if (inferKind(next) === "fund" && field.group === "stock" && value !== null && value !== (previous[field.user] ?? null)) {
        throw new Error(`${field.user}: 投資信託・ETFでは編集できません。`);
      }
    }
  }
  function toSaveData(data) {
    return { ...data, holdings: data.holdings.map(holding => {
      const copy = { ...holding };
      for (const field of fields) delete copy[field.auto];
      return copy;
    }) };
  }
  function inferKind(holding) {
    return holding?.type === "投資信託" || holding?.user_fund_category_code != null || holding?.auto_fund_category_code != null ? "fund" : "stock";
  }
  function createEditor(root) {
    // Industry codes remain part of the classification schema and save flow, but are
    // intentionally not exposed in this editor so a later analysis UI can reuse them.
    const editableFields = fields.filter(field => field.kind !== "industry");
    root.innerHTML = `<h3>資産分類</h3><p class="classification-note">ユーザー設定を優先して表示します。変更は「保存する」で確定します。</p>
      ${editableFields.map(field => `<div class="classification-field" data-classification="${field.kind}">
        <label for="classification-${field.kind}">${field.label}</label>
        ${field.master ? `<select id="classification-${field.kind}"></select>` :
          `<input id="classification-${field.kind}" placeholder="自動分類を使用" maxlength="128" autocomplete="off" spellcheck="false" />`}
        <button type="button" class="text-button classification-reset" aria-label="${field.label}を自動分類に戻す">自動分類に戻す</button>
      </div>`).join("")}`;
    const nodes = new Map(editableFields.map(field => {
      const row = root.querySelector(`[data-classification="${field.kind}"]`);
      return [field.kind, { row, input: row.querySelector("input, select"), reset: row.querySelector(".classification-reset") }];
    }));
    let original = {}, draft = {}, type = "日本株";
    const dirty = new Set();
    const currentKind = () => inferKind({ ...original, type });
    const active = field => field.group === "both" || field.group === currentKind();

    function renderField(field, updateInput = true) {
      const node = nodes.get(field.kind);
      const user = draft[field.user] ?? null, auto = original[field.auto] ?? null;
      const effective = user ?? auto;
      node.row.hidden = !active(field);
      node.input.disabled = !active(field);
      if (updateInput && field.master) {
        const document = root.ownerDocument;
        const option = (label, value) => { const item = document.createElement("option"); item.textContent = label; item.value = value; return item; };
        const options = [option("自動分類を使用", ""), ...masters[field.master].map(entry => option(entry.label, entry.code))];
        if (effective != null && !masters.getEntry(field.kind, effective)) options.push(option(`既存コード：${effective}`, effective));
        node.input.replaceChildren(...options);
      }
      if (updateInput) node.input.value = effective ?? "";
      node.reset.disabled = user == null;
    }
    function render() {
      for (const field of editableFields) renderField(field);
    }
    for (const field of editableFields) {
      const node = nodes.get(field.kind);
      node.input.addEventListener("change", () => {
        draft[field.user] = node.input.value.trim() || null;
        dirty.add(field.user);
        renderField(field);
      });
      if (!field.master) node.input.addEventListener("input", () => {
        draft[field.user] = node.input.value.trim() || null;
        dirty.add(field.user);
        renderField(field, false);
      });
      node.reset.addEventListener("click", () => {
        draft[field.user] = null;
        dirty.add(field.user);
        renderField(field);
      });
    }
    return {
      open(holding, assetType) {
        original = { ...(holding || {}) }; draft = { ...original }; dirty.clear();
        type = assetType; render();
      },
      setType(assetType) { type = assetType; render(); },
      getPatch() {
        const patch = {};
        for (const field of editableFields) {
          if (!active(field) || !dirty.has(field.user)) continue;
          const value = draft[field.user] ?? null;
          if (!validateUserCode(field.kind, value)) throw new Error(`${field.label}のコードが不正です。`);
          patch[field.user] = value;
        }
        return patch;
      }
    };
  }
  return Object.freeze({ fields, validateUserCode, assertEditableClassification, toSaveData, inferKind, createEditor });
});
