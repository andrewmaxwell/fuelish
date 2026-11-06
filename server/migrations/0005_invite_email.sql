-- An invite can name the Google account it's for. Signing in with that address (in the app or on the
-- web) uses the invite with no link or code, so a new person only needs to install the app.
ALTER TABLE invites ADD COLUMN email TEXT;
CREATE INDEX invites_email ON invites (email) WHERE email IS NOT NULL;
