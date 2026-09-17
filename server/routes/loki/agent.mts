/**
 * 采集端的注册与身份维护。
 *
 * 身份不靠机器指纹判定。实测过：LXC 容器里读不到 DMI `product_uuid`，云厂商的
 * instance-id 在容器里取到的是**宿主虚拟机**的 ID（同一台宿主上的容器会拿到同一个值），
 * machine-id 和磁盘内容又会被克隆原样复制。靠这些判身份必然误伤或漏判。
 *
 * 判定改为令牌轮换：服务端对每个身份只认一个当前令牌，每次心跳校验通过就换发新的。
 * 克隆机带着同一份配置出生，手里是同一个令牌，等原机轮换过一轮之后它再来报到，
 * 用的就是作废令牌——**同一个身份被两个进程持有**，这件事本身就是克隆的证据。
 *
 * 唯一要小心的是「响应丢了」：Agent 报完没收到回复，手里还是旧令牌。它自己知道这件事，
 * 会带 `retry` 标记再来一次，这种给一次补发机会；克隆机以为自己一切正常，不会带这个标记。
 * 这一个标记就把「重试」和「克隆」分开了。
 */
import type { DatabaseAdapter } from '../../database/index.mjs';
import { withDatabaseActors } from '../../database/index.mjs';
import { firstSql, runSystemSql, sql } from '../../database/sql.mjs';
import { createPushSecret, hashPushSecret } from './sources.mjs';

export type AgentCredentials = {
	host: string;
	pushUser: string;
	pushSecret: string;
	agentToken: string;
};

/** 心跳的结果：换发新令牌，或者判定为克隆、已经拆成新身份。 */
export type HeartbeatResult =
	| { kind: 'rotated'; agentToken: string }
	| { kind: 'cloned'; credentials: AgentCredentials };

type SourceRow = {
	id: string;
	owner_tid: string;
	owner_bid: string;
	host: string;
	agent_token_hash: string;
	previous_token_hash: string;
	previous_retry_used: unknown;
	title: string;
};

const HOST_PATTERN = /[^A-Za-z0-9_.-]/g;

const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

const truthy = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';

const sanitizeHost = (value: string) => value.trim().replace(HOST_PATTERN, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'host';

/** 租户内 host 必须唯一：同名就加 -2、-3……克隆拆分出来的机器也走这里拿新名字。 */
const uniqueHost = async (database: DatabaseAdapter, desired: string) => {
	const base = sanitizeHost(desired);
	for (let suffix = 1; suffix < 1000; suffix += 1) {
		const candidate = suffix === 1 ? base : `${base}-${suffix}`;
		const taken = await firstSql(database, sql({ database }).select({
			table: 'loki_sources', columns: { id: 'id' }, where: [{ column: 'host', value: candidate }], limit: 1,
		}));
		if (!taken) return candidate;
	}
	throw new Error('无法为这台机器分配 host 标签');
};

/** 推送用户名全局唯一，带随机后缀；它同时是网关查凭据的键。 */
const uniquePushUser = async (database: DatabaseAdapter, host: string) => {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const candidate = `${host}-${Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex')}`;
		const taken = await firstSql(database, sql({ database }).select({
			table: 'loki_sources', columns: { id: 'id' }, where: [{ column: 'push_user', value: candidate }], limit: 1,
		}));
		if (!taken) return candidate;
	}
	throw new Error('无法为这台机器分配推送用户名');
};

const createSource = async (
	database: DatabaseAdapter,
	options: { tenantId: string; branchId: string; title: string; hostname: string; fingerprint: string; clonedFromId?: string },
): Promise<AgentCredentials> => {
	// 租户来自注册令牌或被克隆的那条记录，不来自会话：这条路径上没有登录用户。
	const scoped = withDatabaseActors(database, { baseTenantId: options.tenantId, baseBranchId: options.branchId });
	const host = await uniqueHost(scoped, options.hostname);
	const pushUser = await uniquePushUser(scoped, host);
	const secret = await createPushSecret();
	const agentToken = randomToken();
	await runSystemSql(scoped, sql({ database: scoped }).insert('loki_sources', {
		title: options.title || host,
		host,
		push_user: pushUser,
		push_secret_hash: secret.hash,
		status: 'enabled',
		agent_token_hash: await hashPushSecret(agentToken),
		token_rotated_at: Date.now(),
		fingerprint: options.fingerprint,
		...(options.clonedFromId ? { cloned_from_id: options.clonedFromId, clone_pending: true } : {}),
	}));
	return { host, pushUser, pushSecret: secret.secret, agentToken };
};

/**
 * 用注册令牌换取这台机器专属的凭据。注册令牌按租户/批次发放，同一条命令可以在很多台机器上执行；
 * 它只能用来注册新机器，改不了已有机器的凭据。
 */
export const registerAgent = async (
	database: DatabaseAdapter,
	input: { enrollToken: string; hostname: string; fingerprint: string },
): Promise<AgentCredentials | undefined> => {
	const tokenHash = await hashPushSecret(input.enrollToken);
	const row = await firstSql<{ id: string; owner_tid: string; owner_bid: string; status: string; expires_at: string; max_uses: number; used_count: number; title: string }>(
		database,
		sql({ database }).select({
			table: 'loki_enroll_tokens',
			columns: { id: { column: 'id', cast: 'text' }, owner_tid: { column: 'owner_tid', cast: 'text' }, owner_bid: { column: 'owner_bid', cast: 'text' }, status: 'status', expires_at: { column: 'expires_at', cast: 'text' }, max_uses: 'max_uses', used_count: 'used_count', title: 'title' },
			where: [{ column: 'token_hash', value: tokenHash }],
			limit: 1,
		}),
	);
	if (!row || row.status !== 'enabled') return undefined;
	const expiresAt = Number(row.expires_at ?? 0);
	if (expiresAt && expiresAt < Date.now()) return undefined;
	if (row.max_uses && Number(row.used_count) >= row.max_uses) return undefined;

	const credentials = await createSource(database, {
		tenantId: row.owner_tid,
		branchId: row.owner_bid,
		title: input.hostname || row.title,
		hostname: input.hostname,
		fingerprint: input.fingerprint,
	});
	await runSystemSql(database, sql({ database }).update('loki_enroll_tokens', {
		used_count: Number(row.used_count) + 1,
		last_used_at: Date.now(),
	}, { id: row.id }));
	return credentials;
};

/**
 * 心跳：校验并轮换身份令牌，顺便更新指纹。
 *
 * 判定顺序就是三种情形：手里是当前令牌（正常）、是上一个且声明了重试（响应丢了）、
 * 其余一律是克隆。
 */
export const heartbeatAgent = async (
	database: DatabaseAdapter,
	input: { sourceId: string; agentToken: string; retry: boolean; hostname: string; fingerprint: string },
): Promise<HeartbeatResult> => {
	const row = await firstSql<SourceRow>(database, sql({ database }).select({
		table: 'loki_sources',
		columns: {
			id: { column: 'id', cast: 'text' }, owner_tid: { column: 'owner_tid', cast: 'text' }, owner_bid: { column: 'owner_bid', cast: 'text' },
			host: 'host', title: 'title', agent_token_hash: 'agent_token_hash', previous_token_hash: 'previous_token_hash', previous_retry_used: 'previous_retry_used',
		},
		where: [{ column: 'id', value: input.sourceId }],
		limit: 1,
	}));
	if (!row) throw new Error('源站记录不存在');

	const presented = input.agentToken ? await hashPushSecret(input.agentToken) : '';
	const now = Date.now();
	/**
	 * 换发新令牌。`keepPrevious` 用于补发：Agent 手里那个令牌要继续认下去，
	 * 否则连续两次响应丢失时，它第二次带来的还是同一个令牌，而那时它已经不是
	 * 「上一个」了——会被判成克隆。
	 */
	const rotate = async (keepPrevious = false) => {
		const next = randomToken();
		await runSystemSql(database, sql({ database }).update('loki_sources', {
			...(keepPrevious ? {} : { previous_token_hash: row.agent_token_hash, previous_retry_used: false }),
			agent_token_hash: await hashPushSecret(next),
			token_rotated_at: now,
			fingerprint: input.fingerprint,
			last_seen_at: now,
		}, { id: row.id }));
		return { kind: 'rotated' as const, agentToken: next };
	};

	// 还没有令牌的记录（手工建的、或刚升级上来的）：这次心跳就把身份接上。
	if (!row.agent_token_hash) return rotate();
	if (presented && presented === row.agent_token_hash) return rotate();

	// 上一个令牌 + Agent 明确声明的重试：补发。
	// 这里不限次数：区分「重试」和「克隆」的是 retry 标记本身——Agent 只有在真的没收到
	// 响应时才带它，而克隆机以为自己一切正常，不会带。限次数反而会在连续丢包时误伤。
	if (presented && presented === row.previous_token_hash && input.retry) {
		await runSystemSql(database, sql({ database }).update('loki_sources', {
			previous_retry_used: true,
			last_seen_at: now,
		}, { id: row.id }));
		// 当前令牌的明文只在发出去那一刻存在过，服务端只留哈希，没法重发同一个，
		// 因此补发也是换一个新的——对 Agent 来说效果一样。
		return rotate(true);
	}

	// 其余情况：同一个身份被另一个进程持有过。拆成新身份，原记录留在原地。
	const credentials = await createSource(database, {
		tenantId: row.owner_tid,
		branchId: row.owner_bid,
		title: input.hostname || row.title,
		hostname: input.hostname || row.host,
		fingerprint: input.fingerprint,
		clonedFromId: row.id,
	});
	return { kind: 'cloned', credentials };
};
