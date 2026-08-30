DELETE s FROM passport_sessions s
LEFT JOIN base_devices d ON d.id = s.device_id AND d.id = d.fingerprint
WHERE s.device_id IS NOT NULL AND d.id IS NULL;
DELETE FROM base_devices WHERE id <> fingerprint;
