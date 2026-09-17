/**
 * 源站（采集端）记录与推送凭据。
 *
 * 凭据一源站一份：共用一份时轮换要改所有源站，停用一台等于停用全部。
 */
import type { DatabaseAdapter } from '../../database/index.mjs';
import { firstSql, runSystemSql, sql } from '../../database/sql.mjs';

export type SourceCredential = {
	id: string;
	/** Loki 的租户 ID 取项目的 owner_tid，不另立一套租户概念。 */
	tenantId: string;
	pushSecretHash: string;
	enabled: boolean;
};

const encoder = new TextEncoder();

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/**
 * 推送密钥的摘要用 SHA-256，**不用**账号密码那套 PBKDF2。
 *
 * 慢哈希是为低熵的人类密码准备的，代价是每次校验上百毫秒（本项目的账号密码是 21 万次迭代）。
 * 推送密钥是这里生成的 32 字节随机串，穷举不可行，慢哈希买不到额外安全性；
 * 而校验发生在每一次推送上——每台源站每秒一次，几十台源站就能把 CPU 吃光。
 */
export const hashPushSecret = async (secret: string) =>
	toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret))));

/** 生成推送密钥。明文只在创建时返回一次，库里只留摘要。 */
export const createPushSecret = async () => {
	const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
	return { secret, hash: await hashPushSecret(secret) };
};

export const findSourceByPushUser = async (database: DatabaseAdapter, pushUser: string): Promise<SourceCredential | undefined> => {
	const row = await firstSql<{ id: unknown; owner_tid: unknown; push_secret_hash: unknown; status: unknown }>(database, sql({ database }).select({
		table: 'loki_sources',
		columns: { id: 'id', owner_tid: 'owner_tid', push_secret_hash: 'push_secret_hash', status: 'status' },
		where: [{ column: 'push_user', value: pushUser }],
		limit: 1,
	}));
	if (!row) return undefined;
	return {
		id: String(row.id),
		tenantId: String(row.owner_tid),
		pushSecretHash: String(row.push_secret_hash ?? ''),
		enabled: String(row.status) === 'enabled',
	};
};

/** 记录最后一次成功推送。调用方负责限频——每条推送都写一次库没有意义。 */
export const touchSource = async (database: DatabaseAdapter, id: string) =>
	runSystemSql(database, sql({ database }).update('loki_sources', { last_seen_at: Date.now() }, { id }));
