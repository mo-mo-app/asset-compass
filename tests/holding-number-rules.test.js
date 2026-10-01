const assert = require("node:assert/strict");
const { test } = require("node:test");
const rules = require("../holding-number-rules");

for (const [name, holding, quantityOK, quantityBad, costOK, costBad] of [
  ["Japanese stock", { type: "日本株", currency: "JPY" }, "100", "100.5", "1234.56", "1234.567"],
  ["US stock USD", { type: "米国株", currency: "USD" }, "1.1234", "1.12345", "123.4567", "123.45678"],
  ["US stock JPY", { type: "米国株", currency: "JPY" }, "1.1234", "1.12345", "123.45", "123.456"],
  ["mutual fund", { type: "投資信託", currency: "JPY" }, "163067", "163067.5", "16799", "16799.72"],
  ["iDeCo", { type: "投資信託", currency: "JPY", accountCategoryCode: "ideco" }, "163067", "163067.5", "273948", "273948.5"]
]) {
  test(`${name} precision allows the boundary and rejects excess decimals`, () => {
    for (const [field, valid, invalid] of [["quantity", quantityOK, quantityBad], ["cost", costOK, costBad]]) {
      assert.equal(rules.validate(valid, holding, field).value, Number(valid));
      assert.ok(rules.validate(invalid, holding, field).error);
    }
  });
}
test("decimal parsing accepts valid grouping, incomplete decimal notation and insignificant zeros", () => {
  const h = { type: "日本株", currency: "JPY" };
  for (const [raw, expected] of [["1.", "1"], [".5", "0.5"], ["1.2300", "1.23"], ["1,234.50", "1234.5"]]) {
    const result = rules.validate(raw, h, "cost");
    assert.equal(result.text, expected); assert.equal(result.value, Number(expected));
  }
  assert.ok(rules.validate("1.2340", h, "cost").error);
  assert.equal(rules.validate("163067.999999999999999", h, "quantity").value, undefined);
  assert.equal(rules.format("1.2300"), "1.23");
});
test("invalid grouping, blanks, negatives, non-numbers and unsafe magnitudes cannot be saved", () => {
  const h = { type: "米国株", currency: "USD" };
  for (const value of ["1,,234", "12,34", "1,234,", "", " ", "-1", "abc", "NaN", "Infinity", "1e4", "9007199254740992", "9999999999999.1234"]) {
    assert.ok(rules.validate(value, h, "cost").error, value);
  }
  assert.ok(rules.validate("0", h, "quantity").error);
  assert.equal(rules.validate("0", h, "cost").value, 0);
  assert.equal(rules.validate(String(Number.MAX_SAFE_INTEGER), h, "quantity").value, Number.MAX_SAFE_INTEGER);
});
test("formatting preserves actual legacy decimals and expands Number exponent notation", () => {
  for (const [value, expected] of [[100, "100"], [1.1234, "1.1234"], [1.123456, "1.123456"], [163067, "163,067"], [16799.72036034268, "16,799.72036034268"], [1e-7, "0.0000001"]]) {
    assert.equal(rules.format(value), expected);
  }
});
test("stored-number validation exempts only unchanged values with the same meaning, and never rounds derived iDeCo cost", () => {
  const legacy = { type: "米国株", currency: "USD", symbol: "AAPL", accountCategoryCode: "specified", quantity: 1.123456, cost: 12.123456 };
  assert.equal(rules.validateStored(legacy.quantity, legacy, "quantity", legacy).value, legacy.quantity);
  assert.ok(rules.validateStored(1.12345, legacy, "quantity", legacy).error);
  assert.ok(rules.validateStored(legacy.quantity, { ...legacy, symbol: "MSFT" }, "quantity", legacy).error);
  assert.ok(rules.validateStored(legacy.cost, { ...legacy, currency: "JPY" }, "cost", legacy).error);
  const cost = 273948 / 163067 * 10000;
  assert.equal(rules.validateStored(cost, { type: "投資信託", currency: "JPY", accountCategoryCode: "ideco" }, "cost").value, cost);
});

test("iDeCo derived costs represent whole yen and retain floating-point calculation noise", () => {
  const cases = [
    [163067, 273948 / 163067 * 10000, 273948],
    [99999999, 1 / 99999999 * 10000, 1],
    [163067, 100000000 / 163067 * 10000, 100000000]
  ];
  for (const [quantity, cost, expected] of cases) {
    assert.equal(rules.validateIdecoAcquisitionAmount(quantity, cost).value, expected);
  }
  assert.equal(rules.validateIdecoAcquisitionAmount(163067, 16799.72036034268).value, 273948);
  assert.ok(rules.validateIdecoAcquisitionAmount(10000, 1.5).error);
  assert.ok(rules.validateIdecoAcquisitionAmount(10000, 100.01).error);
});

test("iDeCo acquisition amount validation rejects unsafe inputs and ambiguous precision", () => {
  for (const [quantity, cost] of [[0, 100], [1.5, 100], [10000, -1], [10000, Infinity], [1, Number.MAX_VALUE]]) {
    assert.ok(rules.validateIdecoAcquisitionAmount(quantity, cost).error);
  }
});

test("iDeCo yen tolerance scales down for tiny derived costs at the maximum safe quantity", () => {
  const quantity = Number.MAX_SAFE_INTEGER;
  const oneYenCost = 1 / quantity * 10000;
  const fractionalYenCost = 1.001 / quantity * 10000;

  assert.equal(rules.validateIdecoAcquisitionAmount(quantity, oneYenCost).value, 1);
  assert.ok(rules.validateIdecoAcquisitionAmount(quantity, fractionalYenCost).error);
});
