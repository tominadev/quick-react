CREATE TABLE IF NOT EXISTS base_users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT NOT NULL UNIQUE,
	password TEXT NOT NULL,
	roles TEXT NOT NULL DEFAULT '[]',
	status TEXT NOT NULL DEFAULT 'enabled',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS base_sessions (
	id TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (user_id) REFERENCES base_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS base_sessions_user_id
	ON base_sessions(user_id);

CREATE TABLE IF NOT EXISTS base_configs (
	key TEXT PRIMARY KEY NOT NULL,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS base_bootstrap (
	key TEXT PRIMARY KEY NOT NULL,
	value TEXT NOT NULL
);

INSERT INTO base_bootstrap (key, value) VALUES ('initial_admin', 'open')
ON CONFLICT(key) DO NOTHING;
