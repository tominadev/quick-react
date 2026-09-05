import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';

/**
 * 全局共享的雪花号发号器。
 *
 * 纪元与位宽沿用 Passport 老项目（41 位毫秒 + 10 位 worker + 12 位序列），因为
 * `passport_users.key` 就是老库里的那个 `user_id`，值必须一模一样。
 */
export const SNOWFLAKE_EPOCH = 1288834974657n;
const STATE_TABLE = 'global_snowflake_state';
const MAX_TIMESTAMP_DELTA = (1n << 41n) - 1n;
const MAX_SEQUENCE = 0xfff;
/**
 * 一次预留多少个逻辑毫秒。
 *
 * **发号必须是同步的**：`key` 由 SQL 构造器在每次 INSERT 时补上，而那是个同步函数——
 * 每发一个号都去数据库预留一毫秒（Passport 老实现的做法）在这里行不通。
 * 改成一次预留一段：写一次库拿到 30000 个逻辑毫秒，之后 30000 × 4096 ≈ 1.2 亿个号
 * 都在内存里发，用完再异步续。
 *
 * 预留是**原子推进**（`advanceNumber` 的 WHERE 带旧值），因此两个进程、两个 isolate
 * 即使配了同一个 worker id，拿到的也是彼此不相交的两段——这正是这张状态表存在的理由，
 * 也是进程重启后不会把已经发出去的号再发一遍的原因。
 */
const RESERVE_MILLISECONDS = 30_000;
/** 剩余不到这么多逻辑毫秒就在后台续下一段，别等到用光。 */
const REFILL_THRESHOLD = 5_000;

const parseWorkerId = (value: unknown) => {
	const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
	if (!/^\d{1,4}$/.test(text)) throw new Error('SNOWFLAKE_WORKER_ID must be an integer from 0 to 1023');
	const workerId = Number(text);
	if (!Number.isInteger(workerId) || workerId < 0 || workerId > 1023) throw new Error('SNOWFLAKE_WORKER_ID must be an integer from 0 to 1023');
	return workerId;
};

type Reservation = { timestamp: number; limit: number; sequence: number };

let workerId = 0;
let reservation: Reservation | undefined;
let refilling: Promise<void> | undefined;
let source: DatabaseAdapter | undefined;

/** 原子预留一段逻辑毫秒，返回这一段的起点与终点。 */
const reserveBlock = async (database: DatabaseAdapter) => {
	const now = Math.max(Date.now(), Number(SNOWFLAKE_EPOCH));
	const reserve = async (target: DatabaseAdapter) => {
		await runSql(target, sql({ database: target }).ignoreInsert(STATE_TABLE, ['worker_id'], { worker_id: workerId, last_timestamp: now - 1 }));
		// 推进到 max(已存, now) + 窗口：并发下只有一个请求能从旧值推到新值，另一个读到的
		// 是已经被推过的值，于是两段不会重叠。
		// 推进一整段：MAX(已存 + 段长, now + 段长)。两种情况都保证新段的起点大于已存值，
		// 也就是大于所有已经发出去的号。
		await runSql(target, sql({ database: target }).advanceNumber(STATE_TABLE, 'last_timestamp', now + RESERVE_MILLISECONDS, now, { worker_id: workerId }, RESERVE_MILLISECONDS));
		return firstSql<{ last_timestamp: number }>(target, sql({ database: target }).select({
			table: STATE_TABLE, columns: { last_timestamp: 'last_timestamp' }, where: [{ column: 'worker_id', value: workerId }],
		}));
	};
	const row = database.transaction ? await database.transaction(reserve) : await reserve(database);
	// 有些适配器按 BigInt 读整数（迁移工具就是这么开的），先归一成 number 再判。
	const limit = Number(row?.last_timestamp ?? Number.NaN);
	if (!Number.isSafeInteger(limit)) throw new Error('无法预留雪花号段');
	const timestamp = limit - RESERVE_MILLISECONDS + 1;
	const delta = BigInt(limit) - SNOWFLAKE_EPOCH;
	if (delta < 0n || delta > MAX_TIMESTAMP_DELTA) throw new Error('雪花号的时间戳超出 41 位范围');
	return { timestamp, limit, sequence: 0 } satisfies Reservation;
};

/**
 * 启动时（Node）或第一次请求时（Workers）调用一次，把号段准备好。
 *
 * 之后 {@link nextSnowflake} 就是纯内存的同步函数。重复调用是安全的：已经有号段就直接返回。
 */
export const primeSnowflake = async (database: DatabaseAdapter, configuredWorkerId: unknown) => {
	workerId = parseWorkerId(configuredWorkerId ?? 0);
	source = database;
	if (reservation && reservation.timestamp < reservation.limit) return;
	reservation = await reserveBlock(database);
};

/** 号段快用完了就在后台续一段；续不上不影响当前这一段继续发。 */
const refill = () => {
	if (refilling || !source) return;
	const database = source;
	refilling = reserveBlock(database).then((next) => {
		// 只在新号段确实更靠后时替换，避免把还没用完的一段丢掉。
		if (!reservation || next.timestamp >= reservation.timestamp) reservation = next;
	}).catch(() => undefined).finally(() => { refilling = undefined; });
};

/**
 * 发一个号。**同步**，返回十进制字符串。
 *
 * 返回字符串而不是 bigint：这些值要进 `key` 列（TEXT），也要进 JSON 响应。
 * 老实现返回 BigInt，于是每一个读它的查询都得 `cast: 'text'`，漏一处就抛
 * 「Value is too large to be represented as a JavaScript number」，而 `Number()`
 * 那一路更糟——不报错，静默算成另一个数。字符串从源头上断了这两条路。
 */
export const nextSnowflake = (): string => {
	if (!reservation) throw new Error('雪花发号器尚未初始化：请先调用 primeSnowflake');
	if (reservation.sequence > MAX_SEQUENCE) {
		reservation = { timestamp: reservation.timestamp + 1, limit: reservation.limit, sequence: 0 };
	}
	if (reservation.timestamp > reservation.limit) throw new Error('雪花号段已用尽');
	if (reservation.limit - reservation.timestamp < REFILL_THRESHOLD) refill();
	const id = ((BigInt(reservation.timestamp) - SNOWFLAKE_EPOCH) << 22n)
		| (BigInt(workerId) << 12n)
		| BigInt(reservation.sequence);
	reservation.sequence += 1;
	return id.toString();
};

/**
 * **仅供测试**：不碰数据库直接给一段号。
 *
 * 生产路径一律走 {@link primeSnowflake}——没有数据库里的原子预留，重启和多进程都可能重号。
 * 单元测试里既没有库也不需要那份保证，给个固定起点还能让断言是确定的。
 */
export const useMemorySnowflake = (timestamp = Date.now(), id = 0) => {
	workerId = id;
	source = undefined;
	reservation = { timestamp: Math.max(timestamp, Number(SNOWFLAKE_EPOCH)), limit: Number.MAX_SAFE_INTEGER, sequence: 0 };
};

/** 测试用：把发号器恢复成未初始化状态。 */
export const resetSnowflake = () => { reservation = undefined; source = undefined; refilling = undefined; };
