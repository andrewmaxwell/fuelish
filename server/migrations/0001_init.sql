-- Recording metadata. The full recording.json from the phone is kept in meta_json
-- so new fields never require a migration; columns exist only for listing/sorting.
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- recording | stopped | interrupted (as reported by phone)
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  chunk_count INTEGER,               -- final chunk count once the phone stops; NULL while recording
  meta_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX recordings_started ON recordings (started_at_ms DESC);

-- One row per uploaded chunk. (recording_id, seq) is the idempotency key.
CREATE TABLE chunks (
  recording_id TEXT NOT NULL REFERENCES recordings (id),
  seq INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  meta_json TEXT NOT NULL,           -- chunk stats computed on the phone (counts, intervals, track preview)
  uploaded_at_ms INTEGER NOT NULL,
  PRIMARY KEY (recording_id, seq)
);
