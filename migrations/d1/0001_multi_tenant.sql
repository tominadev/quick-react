CREATE TABLE IF NOT EXISTS global_sites (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	site_key TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	base_site_key TEXT,
	dsn TEXT NOT NULL DEFAULT '',
	dsn_password TEXT,
	database_binding TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'enabled',
	migration_status TEXT NOT NULL DEFAULT 'ready',
	is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
	is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
	CHECK (site_key GLOB '[a-z]*' AND site_key NOT GLOB '*[^a-z0-9_]*')
);

CREATE UNIQUE INDEX IF NOT EXISTS global_sites_one_default
	ON global_sites(is_default) WHERE is_default = 1 AND status = 'enabled';

CREATE TABLE IF NOT EXISTS global_site_hosts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	hostname TEXT NOT NULL UNIQUE,
	site_key TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'enabled',
	created_at INTEGER NOT NULL,
	FOREIGN KEY (site_key) REFERENCES global_sites(site_key)
);

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

INSERT INTO global_sites (
	site_key, name, base_site_key, dsn, status, migration_status, is_default, is_system
) VALUES ('global', '全局控制面', 'base', '', 'enabled', 'ready', 1, 1)
ON CONFLICT(site_key) DO NOTHING;

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

CREATE TABLE IF NOT EXISTS global_cloud_credentials (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	provider TEXT NOT NULL,
	account_id TEXT NOT NULL DEFAULT '',
	access_key_id TEXT NOT NULL DEFAULT '',
	access_key_secret TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'enabled',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS global_cloud_object_storage_buckets (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	cloud_credential_id INTEGER NOT NULL,
	endpoint TEXT NOT NULL,
	region TEXT NOT NULL DEFAULT '',
	bucket TEXT NOT NULL,
	path_style INTEGER NOT NULL DEFAULT 0 CHECK (path_style IN (0, 1)),
	public_base_url TEXT NOT NULL DEFAULT '',
	extra_config TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'enabled',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (cloud_credential_id, endpoint, bucket),
	FOREIGN KEY (cloud_credential_id) REFERENCES global_cloud_credentials(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS global_cloud_object_storage_bindings (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	site_key TEXT NOT NULL,
	bucket_id INTEGER NOT NULL,
	key_prefix TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'enabled',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (id, site_key),
	UNIQUE (site_key, bucket_id, key_prefix),
	FOREIGN KEY (site_key) REFERENCES global_sites(site_key) ON DELETE CASCADE,
	FOREIGN KEY (bucket_id) REFERENCES global_cloud_object_storage_buckets(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS global_cloud_object_storage_binding_purposes (
	binding_id INTEGER NOT NULL,
	site_key TEXT NOT NULL,
	purpose TEXT NOT NULL,
	is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
	PRIMARY KEY (binding_id, purpose),
	FOREIGN KEY (binding_id, site_key) REFERENCES global_cloud_object_storage_bindings(id, site_key) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS global_cloud_object_storage_binding_purposes_one_default
	ON global_cloud_object_storage_binding_purposes(site_key, purpose)
	WHERE is_default = 1;
