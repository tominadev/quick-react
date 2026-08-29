CREATE TABLE IF NOT EXISTS passport_device_users (
	device_id TEXT NOT NULL,
	user_id INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	revoked_at INTEGER,
	PRIMARY KEY (device_id, user_id),
	FOREIGN KEY (device_id) REFERENCES passport_devices(id) ON DELETE CASCADE,
	FOREIGN KEY (user_id) REFERENCES passport_users(user_id) ON DELETE RESTRICT
);
INSERT OR IGNORE INTO passport_device_users (device_id, user_id, status, created_at, last_seen_at, revoked_at)
SELECT id, user_id, status, created_at, last_seen_at, revoked_at FROM passport_devices;
CREATE INDEX IF NOT EXISTS passport_device_users_user_id ON passport_device_users(user_id);
CREATE INDEX IF NOT EXISTS passport_device_users_status ON passport_device_users(status);
