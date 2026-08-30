CREATE TABLE IF NOT EXISTS base_device_snapshots (
	id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL,
	device_id VARCHAR(128) NOT NULL,
	fingerprint VARCHAR(128) NOT NULL,
	ip_address VARCHAR(128) NOT NULL DEFAULT '',
	user_agent TEXT NOT NULL,
	platform VARCHAR(255) NOT NULL,
	screen_width INT NOT NULL DEFAULT 0,
	screen_height INT NOT NULL DEFAULT 0,
	captured_at BIGINT NOT NULL,
	KEY base_device_snapshots_device_id (device_id, captured_at),
	CONSTRAINT base_device_snapshots_device_fk FOREIGN KEY (device_id) REFERENCES base_devices(id) ON DELETE CASCADE
);
