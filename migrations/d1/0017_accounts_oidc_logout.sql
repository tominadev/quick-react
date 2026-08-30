ALTER TABLE passport_oidc_clients ADD COLUMN backchannel_logout_uri TEXT NOT NULL DEFAULT '';
ALTER TABLE passport_oidc_authorization_codes ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE passport_oidc_access_tokens ADD COLUMN session_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS base_oidc_sessions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	created_duid INTEGER,
	updated_duid INTEGER,
	issuer TEXT NOT NULL,
	sid TEXT NOT NULL,
	session_id INTEGER NOT NULL UNIQUE,
	UNIQUE (issuer, sid),
	FOREIGN KEY (session_id) REFERENCES base_sessions(id) ON DELETE CASCADE
);
