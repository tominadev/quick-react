CREATE TABLE IF NOT EXISTS base_users (
	id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL,
	created_duid BIGINT NULL,
	updated_duid BIGINT NULL,
	username VARCHAR(255) NOT NULL UNIQUE,
	password TEXT NOT NULL,
	roles LONGTEXT NOT NULL,
	status VARCHAR(32) NOT NULL DEFAULT 'enabled'
);

CREATE TABLE IF NOT EXISTS base_sessions (
	id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL,
	created_duid BIGINT NULL,
	updated_duid BIGINT NULL,
	token_hash VARCHAR(128) NOT NULL UNIQUE,
	user_id BIGINT NOT NULL,
	expires_at BIGINT NOT NULL,
	KEY base_sessions_user_id (user_id),
	CONSTRAINT base_sessions_user_fk FOREIGN KEY (user_id) REFERENCES base_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS base_configs (
	id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL,
	created_duid BIGINT NULL,
	updated_duid BIGINT NULL,
	`key` VARCHAR(255) NOT NULL UNIQUE,
	value LONGTEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS base_bootstrap (
	id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL,
	created_duid BIGINT NULL,
	updated_duid BIGINT NULL,
	`key` VARCHAR(255) NOT NULL UNIQUE,
	value TEXT NOT NULL
);

INSERT IGNORE INTO base_bootstrap (created_at, updated_at, `key`, value) VALUES (0, 0, 'initial_admin', 'open');

CREATE TABLE IF NOT EXISTS base_oidc_login_requests (
	id VARCHAR(128) NOT NULL PRIMARY KEY,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL,
	created_duid BIGINT NULL,
	updated_duid BIGINT NULL,
	issuer VARCHAR(2048) NOT NULL,
	state VARCHAR(255) NOT NULL UNIQUE,
	nonce VARCHAR(255) NOT NULL,
	code_verifier VARCHAR(255) NOT NULL,
	return_path TEXT NOT NULL,
	expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS base_oidc_accounts (
	id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL,
	created_duid BIGINT NULL,
	updated_duid BIGINT NULL,
	issuer VARCHAR(512) NOT NULL,
	subject VARCHAR(255) NOT NULL,
	user_id BIGINT NOT NULL,
	profile LONGTEXT NOT NULL,
	UNIQUE KEY base_oidc_accounts_issuer_subject (issuer, subject),
	KEY base_oidc_accounts_user (user_id),
	CONSTRAINT base_oidc_accounts_user_fk FOREIGN KEY (user_id) REFERENCES base_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS base_oidc_sessions (
	id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
	created_at BIGINT NOT NULL,
	updated_at BIGINT NOT NULL,
	created_duid BIGINT NULL,
	updated_duid BIGINT NULL,
	issuer VARCHAR(512) NOT NULL,
	sid VARCHAR(255) NOT NULL,
	session_id BIGINT NOT NULL UNIQUE,
	UNIQUE KEY base_oidc_sessions_issuer_sid (issuer, sid),
	CONSTRAINT base_oidc_sessions_session_fk FOREIGN KEY (session_id) REFERENCES base_sessions(id) ON DELETE CASCADE
);
