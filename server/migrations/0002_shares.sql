-- Share links: anyone holding a token can view that one recording (read-only, trimmed metadata,
-- no raw chunks). Revoking sets revoked_at_ms; the row stays so old links keep saying "no longer shared".
CREATE TABLE shares (
  token TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings (id),
  created_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
);
CREATE INDEX shares_recording ON shares (recording_id);
