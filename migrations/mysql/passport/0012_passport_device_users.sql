CREATE TABLE IF NOT EXISTS passport_device_users (
	device_id VARCHAR(128) NOT NULL,
	user_id BIGINT NOT NULL,
	status VARCHAR(16) NOT NULL DEFAULT 'active',
	created_at BIGINT NOT NULL,
	last_seen_at BIGINT NOT NULL,
	revoked_at BIGINT NULL,
	PRIMARY KEY (device_id, user_id),
	KEY passport_device_users_user_id (user_id),
	KEY passport_device_users_status (status),
	CONSTRAINT passport_device_users_device_fk FOREIGN KEY (device_id) REFERENCES passport_devices(id) ON DELETE CASCADE,
	CONSTRAINT passport_device_users_user_fk FOREIGN KEY (user_id) REFERENCES passport_users(user_id) ON DELETE RESTRICT
);
INSERT IGNORE INTO passport_device_users (device_id, user_id, status, created_at, last_seen_at, revoked_at)
SELECT id, user_id, status, created_at, last_seen_at, revoked_at FROM passport_devices;
