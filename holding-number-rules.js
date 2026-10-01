(function (root, factory) {
  const rules = factory();
  if (typeof module === "object" && module.exports) module.exports = rules;
  else root.HoldingNumberRules = rules;
})(globalThis, function () {
  const precisions = {
    "日本株": { quantity: 0, cost: 2 },
    "米国株": { quantity: 4, cost: 4 },
    "投資信託": { quantity: 0, cost: 0 }
  };
  function rule(holding, field) {
    const ideco = holding.accountCategoryCode === "ideco";
    const digits = ideco ? 0 : field === "cost" && holding.type === "米国株" && holding.currency === "JPY"
      ? 2 : precisions[holding.type]?.[field];
    const label = field === "quantity" ? (holding.type === "投資信託" ? "保有口数" : "保有数量")
      : ideco ? "取得金額" : holding.type === "投資信託" ? "取得基準価額" : "取得単価";
    return { digits, label, positive: field === "quantity" };
  }
  // Parse the text before converting to Number: malformed grouping and long decimals must not disappear.
  function decimalText(input) {
    const text = String(input ?? "").trim();
    if (!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    const [whole, fraction = ""] = text.replaceAll(",", "").split(".");
    const integer = (whole || "0").replace(/^0+(?=\d)/, "");
    const tail = fraction.replace(/0+$/, "");
    return tail ? `${integer}.${tail}` : integer;
  }
  function numberText(value) {
    if (!Number.isFinite(value) || value < 0) return null;
    const text = String(value);
    if (!/[eE]/.test(text)) return text;
    const [mantissa, exponent] = text.toLowerCase().split("e");
    const [integer, fraction = ""] = mantissa.split(".");
    const digits = integer + fraction, position = integer.length + Number(exponent);
    return position <= 0 ? `0.${"0".repeat(-position)}${digits}`
      : position >= digits.length ? digits + "0".repeat(position - digits.length)
      : `${digits.slice(0, position)}.${digits.slice(position)}`;
  }
  function format(input) {
    const text = decimalText(typeof input === "number" ? numberText(input) : input);
    if (text === null) return null;
    const [integer, fraction] = text.split(".");
    return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
  }
  function validate(input, holding, field, unchangedValue) {
    const definition = rule(holding, field), text = decimalText(input);
    if (text === null) return { error: `${definition.label}は${definition.positive ? "0より大きい" : "0以上の"}数値で入力してください。` };
    if (definition.positive && text === "0") return { error: `${definition.label}は0より大きい数値で入力してください。` };
    // Compare canonical text, not rounded Number values, to grandfather only the actual unchanged value.
    if (unchangedValue !== undefined && text === decimalText(numberText(unchangedValue))) {
      return { value: unchangedValue, text };
    }
    const digits = (text.split(".")[1] || "").length;
    if (definition.digits === undefined || digits > definition.digits) {
      return { error: definition.digits === 0
        ? `${definition.label}は${field === "quantity" ? "整数" : "1円単位"}で入力してください。`
        : `${definition.label}は小数${definition.digits}桁までで入力してください。` };
    }
    // A scaled integer beyond the safe range cannot reliably retain the requested decimal precision.
    if (text.replace(".", "").length > 16 || BigInt(text.replace(".", "")) > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { error: `${definition.label}の値が大きすぎます。安全に扱える範囲で入力してください。` };
    }
    const value = Number(text);
    if (!Number.isFinite(value) || decimalText(numberText(value)) !== text) return { error: `${definition.label}の数値を正確に扱えません。` };
    return { value, text };
  }
  function sameMeaning(previous, current, field) {
    return previous && previous.type === current.type &&
      previous.symbol === current.symbol &&
      (previous.accountCategoryCode === "ideco") === (current.accountCategoryCode === "ideco") &&
      (field === "quantity" || previous.currency === current.currency);
  }
  function validateIdecoAcquisitionAmount(quantity, cost) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(cost) || cost < 0) {
      return { error: "iDeCo acquisition amount is invalid." };
    }
    const amount = cost * quantity / 10000;
    if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) {
      return { error: "iDeCo acquisition amount is outside the safe range." };
    }
    const roundedAmount = Math.round(amount);
    if (!Number.isSafeInteger(roundedAmount)) return { error: "iDeCo acquisition amount is outside the safe range." };

    // Compare against the cost generated from the nearest integer-yen amount.
    // This avoids treating the subtraction error in `cost * quantity / 10000`
    // as user-entered fractional yen, while keeping cost itself unrounded.
    const expectedCost = roundedAmount / quantity * 10000;
    // Scale the allowance to the values being compared. An absolute floor of 1
    // is too generous for tiny derived costs at very large quantities.
    const tolerance = Number.EPSILON * Math.max(Math.abs(cost), Math.abs(expectedCost)) * 8;
    const yenStepInCost = 10000 / quantity;
    const costDifference = Math.abs(cost - expectedCost);
    if (!Number.isFinite(expectedCost) || !Number.isFinite(tolerance) ||
        (costDifference !== 0 && tolerance >= yenStepInCost / 2) || costDifference > tolerance) {
      return { error: "iDeCo acquisition amount must represent whole yen." };
    }
    return { value: roundedAmount };
  }
  // API payloads contain Numbers, so use their shortest decimal representation; iDeCo cost is derived.
  function validateStored(value, holding, field, previous) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (field === "quantity" && value === 0)) {
      return { error: `${field} is invalid.` };
    }
    if (sameMeaning(previous, holding, field) && previous[field] === value) return { value };
    if (field === "cost" && holding.accountCategoryCode === "ideco") {
      return value <= Number.MAX_SAFE_INTEGER ? { value } : { error: "cost is too large." };
    }
    return validate(numberText(value), holding, field);
  }
  return { rule, decimalText, numberText, format, validate, validateStored, sameMeaning, validateIdecoAcquisitionAmount };
});
