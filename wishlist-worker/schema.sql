-- Fort Grozny community car wishlist; separate from FG-ID and payment databases.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS wishlist_cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL UNIQUE,
  author_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved'
    CHECK(status IN ('approved', 'hidden')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wishlist_cars_status_created
  ON wishlist_cars(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wishlist_cars_author_created
  ON wishlist_cars(author_key, created_at DESC);

CREATE TABLE IF NOT EXISTS wishlist_votes (
  car_id INTEGER NOT NULL REFERENCES wishlist_cars(id) ON DELETE CASCADE,
  voter_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(car_id, voter_key)
);
CREATE INDEX IF NOT EXISTS idx_wishlist_votes_voter_created
  ON wishlist_votes(voter_key, created_at DESC);
