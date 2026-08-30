CREATE TABLE IF NOT EXISTS base_device_snapshots (
	id BIGSERIAL PRIMARY KEY,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL,
	device_id VARCHAR(128) NOT NULL REFERENCES base_devices(id) ON DELETE CASCADE,
	fingerprint VARCHAR(128) NOT NULL,
	ip_address VARCHAR(128) NOT NULL DEFAULT '',
	user_agent TEXT NOT NULL DEFAULT '',
	platform VARCHAR(255) NOT NULL DEFAULT '',
	screen_width INTEGER NOT NULL DEFAULT 0,
	screen_height INTEGER NOT NULL DEFAULT 0,
	captured_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS base_device_snapshots_device_id ON base_device_snapshots(device_id, captured_at);
