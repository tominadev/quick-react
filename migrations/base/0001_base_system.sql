CREATE TABLE IF NOT EXISTS base_users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	created_duid INTEGER,
	updated_duid INTEGER,
	username TEXT NOT NULL UNIQUE,
	password TEXT NOT NULL,
	roles TEXT NOT NULL DEFAULT '[]',
	status TEXT NOT NULL DEFAULT 'enabled'
);

CREATE TABLE IF NOT EXISTS base_sessions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	created_duid INTEGER,
	updated_duid INTEGER,
	token_hash TEXT NOT NULL UNIQUE,
	user_id INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	FOREIGN KEY (user_id) REFERENCES base_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS base_sessions_user_id
	ON base_sessions(user_id);

CREATE TABLE IF NOT EXISTS base_configs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	created_duid INTEGER,
	updated_duid INTEGER,
	key TEXT NOT NULL UNIQUE,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS base_bootstrap (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	created_duid INTEGER,
	updated_duid INTEGER,
	key TEXT NOT NULL UNIQUE,
	value TEXT NOT NULL
);

INSERT INTO base_bootstrap (created_at, updated_at, key, value) VALUES (0, 0, 'initial_admin', 'open')
ON CONFLICT(key) DO NOTHING;
