-- People sign in with Google. The first person is the owner (admin), who invites the rest.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,   -- Google's stable account id; the email can change
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  disabled_at_ms INTEGER             -- set: can't sign in, sessions and phone keys stop working
);

-- One row per signed-in browser or app. Only a hash of the cookie value is stored.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Upload keys, one per phone, made when someone signs in inside the Android app.
CREATE TABLE device_keys (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_used_ms INTEGER,
  revoked_at_ms INTEGER
);
CREATE INDEX device_keys_user ON device_keys (user_id);

-- Single-use invite links.
CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_by TEXT REFERENCES users (id),
  used_at_ms INTEGER,
  revoked_at_ms INTEGER
);

-- Whose trip it is. NULL until the owner claims the server (then theirs) or for uploads from the
-- old shared device token before that.
ALTER TABLE recordings ADD COLUMN user_id TEXT REFERENCES users (id);
CREATE INDEX recordings_user ON recordings (user_id, started_at_ms DESC);
