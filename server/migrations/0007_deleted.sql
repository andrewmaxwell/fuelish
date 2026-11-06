-- Trips deleted by their person. Only the id is kept (nothing about the trip itself), so a phone still
-- holding a copy is told it's gone (410) and drops it instead of uploading it again.
CREATE TABLE deleted_recordings (
  id TEXT PRIMARY KEY,
  deleted_at_ms INTEGER NOT NULL
);
