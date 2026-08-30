ALTER TABLE base_devices
	ADD UNIQUE KEY base_devices_fingerprint_unique (fingerprint);
