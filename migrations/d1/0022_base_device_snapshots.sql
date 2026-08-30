CREATE TABLE IF NOT EXISTS base_device_snapshots (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	device_id TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	ip_address TEXT NOT NULL DEFAULT '',
	user_agent TEXT NOT NULL DEFAULT '',
	platform TEXT NOT NULL DEFAULT '',
	screen_width INTEGER NOT NULL DEFAULT 0,
	screen_height INTEGER NOT NULL DEFAULT 0,
	captured_at INTEGER NOT NULL,
	FOREIGN KEY (device_id) REFERENCES base_devices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS base_device_snapshots_device_id ON base_device_snapshots(device_id, captured_at);
