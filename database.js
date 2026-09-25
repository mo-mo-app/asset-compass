const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const databasePath = process.env.ASSET_COMPASS_DB_PATH || path.join(__dirname, "data", "asset-compass.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

function runMigrations() {
  const currentVersion = db.prepare("PRAGMA user_version").get().user_version;
  if (currentVersion > 3) throw new Error(`Database schema version ${currentVersion} is newer than this application supports.`);

  if (currentVersion === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
      CREATE TABLE app_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
        last_quote_fetched_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE accounts (
        id TEXT NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE holdings (
        id TEXT NOT NULL PRIMARY KEY,
        account_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('日本株', '米国株', '投資信託')),
        currency TEXT NOT NULL CHECK (currency IN ('JPY', 'USD')),
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        quantity REAL NOT NULL CHECK (quantity > 0),
        cost REAL NOT NULL CHECK (cost >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
      );

      CREATE TABLE holding_quotes (
        holding_id TEXT NOT NULL PRIMARY KEY,
        price REAL NOT NULL CHECK (price >= 0),
        previous_close REAL,
        price_timestamp INTEGER,
        price_date TEXT,
        FOREIGN KEY (holding_id) REFERENCES holdings(id) ON DELETE CASCADE
      );

      CREATE TABLE fx_rates (
        base_currency TEXT NOT NULL,
        quote_currency TEXT NOT NULL,
        rate REAL NOT NULL CHECK (rate > 0),
        price_timestamp INTEGER,
        PRIMARY KEY (base_currency, quote_currency)
      );

      INSERT INTO app_state (singleton_id, revision, initialized, last_quote_fetched_at, updated_at)
      VALUES (1, 0, 0, NULL, ${Date.now()});
      PRAGMA user_version = 1;
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  if (db.prepare("PRAGMA user_version").get().user_version < 2) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE daily_asset_snapshots (
          snapshot_date TEXT PRIMARY KEY CHECK (date(snapshot_date) = snapshot_date),
          total_value_jpy REAL CHECK (total_value_jpy IS NULL OR total_value_jpy >= 0),
          usd_jpy_rate REAL CHECK (usd_jpy_rate IS NULL OR usd_jpy_rate > 0),
          saved_at INTEGER NOT NULL,
          holding_count INTEGER NOT NULL CHECK (holding_count >= 0),
          valued_holding_count INTEGER NOT NULL CHECK (valued_holding_count >= 0),
          unpriced_holding_count INTEGER NOT NULL CHECK (unpriced_holding_count >= 0),
          quote_failure_count INTEGER NOT NULL CHECK (quote_failure_count >= 0),
          is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1))
        );

        CREATE TABLE daily_account_snapshots (
          snapshot_date TEXT NOT NULL,
          account_id TEXT NOT NULL,
          account_name TEXT NOT NULL,
          value_jpy REAL CHECK (value_jpy IS NULL OR value_jpy >= 0),
          holding_count INTEGER NOT NULL CHECK (holding_count >= 0),
          valued_holding_count INTEGER NOT NULL CHECK (valued_holding_count >= 0),
          unpriced_holding_count INTEGER NOT NULL CHECK (unpriced_holding_count >= 0),
          PRIMARY KEY (snapshot_date, account_id),
          FOREIGN KEY (snapshot_date) REFERENCES daily_asset_snapshots(snapshot_date) ON DELETE CASCADE
        );

        CREATE INDEX daily_account_snapshots_account_date
          ON daily_account_snapshots (account_id, snapshot_date);

        PRAGMA user_version = 2;
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (db.prepare("PRAGMA user_version").get().user_version < 3) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE holdings ADD COLUMN quote_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (quote_status IN ('unknown', 'success', 'failed'));
        ALTER TABLE holdings ADD COLUMN quote_attempted_at INTEGER
          CHECK (quote_attempted_at IS NULL OR quote_attempted_at > 0);
        -- Old previous_close may be a range-start close or a current-price fallback.
        -- Preserve prices/history, but require a fresh quote before daily comparisons.
        UPDATE holding_quotes SET previous_close = NULL;
        PRAGMA user_version = 3;
      `);
      db.prepare("UPDATE app_state SET revision = revision + 1, updated_at = ? WHERE initialized = 1").run(Date.now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

runMigrations();

function optionalTimestamp(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${fieldName} must be a positive Unix-millisecond timestamp or null.`);
  return value;
}

function optionalNumber(value, fieldName, { positive = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`${fieldName} must be a valid ${positive ? "positive " : "non-negative "}number or null.`);
  }
  return value;
}

function requiredText(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${fieldName} is required.`);
  return value.trim();
}

function normalizeState(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.accounts) || !Array.isArray(input.holdings)) {
    throw new Error("State must contain accounts and holdings arrays.");
  }

  const accounts = input.accounts.map((account, index) => ({
    id: requiredText(account?.id, `accounts[${index}].id`),
    name: requiredText(account?.name, `accounts[${index}].name`),
    note: typeof account?.note === "string" ? account.note : ""
  }));
  const accountIds = new Set(accounts.map(account => account.id));
  if (accountIds.size !== accounts.length) throw new Error("Account IDs must be unique.");

  const holdings = input.holdings.map((holding, index) => {
    const field = `holdings[${index}]`;
    const type = requiredText(holding?.type, `${field}.type`);
    const currency = requiredText(holding?.currency, `${field}.currency`);
    if (!["日本株", "米国株", "投資信託"].includes(type)) throw new Error(`${field}.type is invalid.`);
    if (!["JPY", "USD"].includes(currency)) throw new Error(`${field}.currency is invalid.`);
    if (typeof holding?.quantity !== "number" || !Number.isFinite(holding.quantity) || holding.quantity <= 0) throw new Error(`${field}.quantity must be greater than zero.`);
    if (typeof holding?.cost !== "number" || !Number.isFinite(holding.cost) || holding.cost < 0) throw new Error(`${field}.cost must be zero or greater.`);
    const accountId = requiredText(holding?.accountId, `${field}.accountId`);
    if (!accountIds.has(accountId)) throw new Error(`${field}.accountId does not match an account in this state.`);
    const price = optionalNumber(holding.price, `${field}.price`);
    const quoteStatus = holding.quoteStatus ?? "unknown";
    if (!["unknown", "success", "failed"].includes(quoteStatus)) throw new Error(`${field}.quoteStatus is invalid.`);
    const quoteAttemptedAt = optionalTimestamp(holding.quoteAttemptedAt, `${field}.quoteAttemptedAt`);
    // Legacy clients/cache have no status: their comparison values are unverified.
    const previousClose = quoteStatus === "unknown" ? null : optionalNumber(holding.previousClose, `${field}.previousClose`, { positive: true });
    const priceDate = holding.priceDate === null || holding.priceDate === undefined || holding.priceDate === ""
      ? null
      : typeof holding.priceDate === "string" && /^\d{1,2}\/\d{1,2}$/.test(holding.priceDate)
        ? holding.priceDate
        : (() => { throw new Error(`${field}.priceDate must use M/D format or be null.`); })();
    return {
      id: requiredText(holding?.id, `${field}.id`), accountId, type, currency,
      name: requiredText(holding?.name, `${field}.name`),
      symbol: requiredText(holding?.symbol, `${field}.symbol`),
      quantity: holding.quantity, cost: holding.cost, price, previousClose, quoteStatus, quoteAttemptedAt,
      priceTimestamp: optionalTimestamp(holding.priceTimestamp, `${field}.priceTimestamp`),
      priceDate
    };
  });
  if (new Set(holdings.map(holding => holding.id)).size !== holdings.length) throw new Error("Holding IDs must be unique.");

  return {
    accounts,
    holdings,
    usdJpyRate: optionalNumber(input.usdJpyRate, "usdJpyRate", { positive: true }),
    usdJpyTimestamp: optionalTimestamp(input.usdJpyTimestamp, "usdJpyTimestamp"),
    lastQuoteFetchedAt: optionalTimestamp(input.lastQuoteFetchedAt, "lastQuoteFetchedAt")
  };
}

function upsertState(data) {
  const now = Date.now();
  const upsertAccount = db.prepare(`
    INSERT INTO accounts (id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, note = excluded.note, updated_at = excluded.updated_at
  `);
  const upsertHolding = db.prepare(`
    INSERT INTO holdings (id, account_id, type, currency, name, symbol, quantity, cost, created_at, updated_at, quote_status, quote_attempted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, type = excluded.type,
      currency = excluded.currency, name = excluded.name, symbol = excluded.symbol,
      quantity = excluded.quantity, cost = excluded.cost, updated_at = excluded.updated_at,
      quote_status = excluded.quote_status, quote_attempted_at = excluded.quote_attempted_at
  `);
  const upsertQuote = db.prepare(`
    INSERT INTO holding_quotes (holding_id, price, previous_close, price_timestamp, price_date)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(holding_id) DO UPDATE SET price = excluded.price, previous_close = excluded.previous_close,
      price_timestamp = excluded.price_timestamp, price_date = excluded.price_date
  `);

  for (const account of data.accounts) upsertAccount.run(account.id, account.name, account.note, now, now);
  for (const holding of data.holdings) {
    upsertHolding.run(holding.id, holding.accountId, holding.type, holding.currency, holding.name, holding.symbol, holding.quantity, holding.cost, now, now, holding.quoteStatus, holding.quoteAttemptedAt);
    if (holding.price !== null) upsertQuote.run(holding.id, holding.price, holding.previousClose, holding.priceTimestamp, holding.priceDate);
    else db.prepare("DELETE FROM holding_quotes WHERE holding_id = ?").run(holding.id);
  }
  if (data.usdJpyRate !== null) {
    db.prepare(`
      INSERT INTO fx_rates (base_currency, quote_currency, rate, price_timestamp) VALUES ('USD', 'JPY', ?, ?)
      ON CONFLICT(base_currency, quote_currency) DO UPDATE SET rate = excluded.rate, price_timestamp = excluded.price_timestamp
    `).run(data.usdJpyRate, data.usdJpyTimestamp);
  }
  db.prepare(`UPDATE app_state SET last_quote_fetched_at = ?, updated_at = ? WHERE singleton_id = 1`)
    .run(data.lastQuoteFetchedAt, now);
}

function getState() {
  const state = db.prepare("SELECT revision, initialized, last_quote_fetched_at, updated_at FROM app_state WHERE singleton_id = 1").get();
  const accounts = db.prepare("SELECT id, name, note FROM accounts ORDER BY rowid").all();
  const holdings = db.prepare(`
    SELECT h.id, h.account_id, h.type, h.currency, h.name, h.symbol, h.quantity, h.cost,
      q.price, q.previous_close, q.price_timestamp, q.price_date, h.quote_status, h.quote_attempted_at
    FROM holdings h LEFT JOIN holding_quotes q ON q.holding_id = h.id ORDER BY h.rowid
  `).all().map(row => ({
    id: row.id, accountId: row.account_id, type: row.type, currency: row.currency,
    name: row.name, symbol: row.symbol, quantity: row.quantity, cost: row.cost,
    price: row.price ?? null, previousClose: row.previous_close ?? null,
    priceTimestamp: row.price_timestamp ?? null, priceDate: row.price_date ?? null,
    quoteStatus: row.quote_status, quoteAttemptedAt: row.quote_attempted_at ?? null
  }));
  const fx = db.prepare("SELECT rate, price_timestamp FROM fx_rates WHERE base_currency = 'USD' AND quote_currency = 'JPY'").get();

  return {
    apiVersion: 1,
    initialized: Boolean(state.initialized),
    revision: state.revision,
    updatedAt: state.updated_at,
    data: {
      accounts,
      holdings,
      usdJpyRate: fx?.rate ?? null,
      usdJpyTimestamp: fx?.price_timestamp ?? null,
      lastQuoteFetchedAt: state.last_quote_fetched_at ?? null
    }
  };
}

function getSnapshots(from, to) {
  const assetRows = db.prepare(`
    SELECT snapshot_date, total_value_jpy, usd_jpy_rate, saved_at, holding_count,
      valued_holding_count, unpriced_holding_count, quote_failure_count, is_complete
    FROM daily_asset_snapshots
    WHERE snapshot_date >= ? AND snapshot_date <= ?
    ORDER BY snapshot_date ASC
  `).all(from, to);
  const accountRows = db.prepare(`
    SELECT snapshot_date, account_id, account_name, value_jpy,
      valued_holding_count, unpriced_holding_count
    FROM daily_account_snapshots
    WHERE snapshot_date >= ? AND snapshot_date <= ?
    ORDER BY snapshot_date ASC, account_id ASC
  `).all(from, to);

  const accountsByDate = new Map();
  for (const row of accountRows) {
    if (!accountsByDate.has(row.snapshot_date)) accountsByDate.set(row.snapshot_date, []);
    accountsByDate.get(row.snapshot_date).push({
      accountId: row.account_id,
      accountName: row.account_name,
      valueJpy: row.value_jpy ?? null,
      valuedHoldingCount: row.valued_holding_count,
      unpricedHoldingCount: row.unpriced_holding_count
    });
  }

  return assetRows.map(row => ({
    date: row.snapshot_date,
    totalValueJpy: row.total_value_jpy ?? null,
    usdJpyRate: row.usd_jpy_rate ?? null,
    savedAt: row.saved_at,
    holdingCount: row.holding_count,
    valuedHoldingCount: row.valued_holding_count,
    unpricedHoldingCount: row.unpriced_holding_count,
    quoteFailureCount: row.quote_failure_count,
    isComplete: Boolean(row.is_complete),
    accounts: accountsByDate.get(row.snapshot_date) || []
  }));
}

function inTransaction(action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function jstDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function saveDailySnapshot(data, { quoteFailureCount }) {
  const savedAt = Date.now();
  const snapshotDate = jstDate(savedAt);
  const quantityDivisor = holding => holding.type === "投資信託" ? 10000 : 1;
  const isValued = holding => holding.price !== null &&
    (holding.currency !== "USD" || data.usdJpyRate !== null);
  const valueOf = holding => holding.price * holding.quantity / quantityDivisor(holding) *
    (holding.currency === "USD" ? data.usdJpyRate : 1);
  const valuedHoldings = data.holdings.filter(isValued);
  const unpricedHoldingCount = data.holdings.length - valuedHoldings.length;
  const totalValue = valuedHoldings.reduce((sum, holding) => sum + valueOf(holding), 0);
  const isComplete = quoteFailureCount === 0 && unpricedHoldingCount === 0;

  db.prepare(`
    INSERT INTO daily_asset_snapshots (
      snapshot_date, total_value_jpy, usd_jpy_rate, saved_at, holding_count,
      valued_holding_count, unpriced_holding_count, quote_failure_count, is_complete
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date) DO UPDATE SET
      total_value_jpy = excluded.total_value_jpy,
      usd_jpy_rate = excluded.usd_jpy_rate,
      saved_at = excluded.saved_at,
      holding_count = excluded.holding_count,
      valued_holding_count = excluded.valued_holding_count,
      unpriced_holding_count = excluded.unpriced_holding_count,
      quote_failure_count = excluded.quote_failure_count,
      is_complete = excluded.is_complete
  `).run(
    snapshotDate, valuedHoldings.length ? totalValue : null, data.usdJpyRate,
    savedAt, data.holdings.length, valuedHoldings.length, unpricedHoldingCount,
    quoteFailureCount, Number(isComplete)
  );

  const upsertAccount = db.prepare(`
    INSERT INTO daily_account_snapshots (
      snapshot_date, account_id, account_name, value_jpy, holding_count,
      valued_holding_count, unpriced_holding_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date, account_id) DO UPDATE SET
      account_name = excluded.account_name,
      value_jpy = excluded.value_jpy,
      holding_count = excluded.holding_count,
      valued_holding_count = excluded.valued_holding_count,
      unpriced_holding_count = excluded.unpriced_holding_count
  `);
  for (const account of data.accounts) {
    const accountHoldings = data.holdings.filter(holding => holding.accountId === account.id);
    const accountValued = accountHoldings.filter(isValued);
    const accountTotal = accountValued.reduce((sum, holding) => sum + valueOf(holding), 0);
    upsertAccount.run(
      snapshotDate, account.id, account.name, accountValued.length ? accountTotal : null,
      accountHoldings.length, accountValued.length, accountHoldings.length - accountValued.length
    );
  }
  return { snapshotDate, savedAt, holdingCount: data.holdings.length, valuedHoldingCount: valuedHoldings.length, unpricedHoldingCount, quoteFailureCount, isComplete };
}

function migrateLocalState(input) {
  const data = normalizeState(input);
  return inTransaction(() => {
    const current = db.prepare("SELECT revision, initialized FROM app_state WHERE singleton_id = 1").get();
    if (current.initialized) return { conflict: true, state: getState() };
    upsertState(data);
    db.prepare("UPDATE app_state SET initialized = 1, revision = revision + 1, updated_at = ? WHERE singleton_id = 1").run(Date.now());
    return { conflict: false, state: getState(), accountsCount: data.accounts.length, holdingsCount: data.holdings.length };
  });
}

function saveState(expectedRevision, input, snapshotMetadata = null) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("expectedRevision must be a non-negative integer.");
  const data = normalizeState(input);
  if (snapshotMetadata !== null && (!Number.isSafeInteger(snapshotMetadata.quoteFailureCount) || snapshotMetadata.quoteFailureCount < 0)) {
    throw new Error("snapshot.quoteFailureCount must be a non-negative integer.");
  }
  return inTransaction(() => {
    const current = db.prepare("SELECT revision, initialized FROM app_state WHERE singleton_id = 1").get();
    if (!current.initialized) return { notInitialized: true, state: getState() };
    if (current.revision !== expectedRevision) return { conflict: true, state: getState() };
    upsertState(data);
    db.prepare("UPDATE app_state SET initialized = 1, revision = revision + 1, updated_at = ? WHERE singleton_id = 1").run(Date.now());
    const snapshot = snapshotMetadata === null ? null : saveDailySnapshot(data, snapshotMetadata);
    return { conflict: false, state: getState(), snapshot };
  });
}

module.exports = { databasePath, db, getState, getSnapshots, migrateLocalState, saveState };
