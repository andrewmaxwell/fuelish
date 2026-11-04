-- Small shared settings the web page edits: place names for repeated trips, trip-cost assumptions.
-- One JSON value per key, so new settings never need a migration.
CREATE TABLE prefs (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
