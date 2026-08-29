CREATE TABLE IF NOT EXISTS passport_device_users (
	device_id TEXT NOT NULL REFERENCES passport_devices(id) ON DELETE CASCADE,
	user_id BIGINT NOT NULL REFERENCES passport_users(user_id) ON DELETE RESTRICT,
	status TEXT NOT NULL DEFAULT 'active',
	created_at BIGINT NOT NULL,
	last_seen_at BIGINT NOT NULL,
	revoked_at BIGINT,
	PRIMARY KEY (device_id, user_id)
);
INSERT INTO passport_device_users (device_id, user_id, status, created_at, last_seen_at, revoked_at)
SELECT id, user_id, status, created_at, last_seen_at, revoked_at FROM passport_devices
ON CONFLICT (device_id, user_id) DO NOTHING;
CREATE INDEX IF NOT EXISTS passport_device_users_user_id ON passport_device_users(user_id);
CREATE INDEX IF NOT EXISTS passport_device_users_status ON passport_device_users(status);
