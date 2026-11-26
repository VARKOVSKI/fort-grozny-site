CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  access_hash TEXT NOT NULL,
  player_id TEXT NOT NULL,
  unity_player_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency = 'RUB'),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  method TEXT NOT NULL CHECK (method IN ('bank_card', 'sbp', 'smart')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'canceled')),
  confirmation_url TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  confirmed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS refunds_payment ON refunds(payment_id);

CREATE TABLE IF NOT EXISTS payment_events (
  resource_id TEXT NOT NULL,
  event TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id),
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (resource_id, event)
);

CREATE TABLE IF NOT EXISTS entitlement_ledger (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'failed', 'refund_review')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
