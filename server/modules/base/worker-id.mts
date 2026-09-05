import { appendFile, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';

/**
 * 这台服务器的 Snowflake worker id（0–1023）。
 *
 * 优先用环境变量；`.env` 里有就用 `.env` 的；两处都没有就从**服务器标识**推一个出来并写回
 * `.env`——推导用 `/etc/machine-id`（同一台机器重装系统才会变），拿不到就退回主机名，
 * 再拿不到就生成一个随机 UUID。之所以要写回文件：worker id 必须跨重启稳定，
 * 每次启动重新随机会让两次运行落在同一毫秒时产生重号。
 *
 * 取模 1024 会撞——两台机器的 machine-id 哈希后可能落在同一个号上。撞了不会立刻出错
 * （号段是原子预留的，同一个 worker id 的两个进程拿到的是不相交的两段），但会白白消耗
 * 号段。集群规模上来之后应该显式配 `SNOWFLAKE_WORKER_ID`，不要依赖推导。
 */
const WORKER_ID_KEY = 'SNOWFLAKE_WORKER_ID';
const WORKER_ID_SPACE = 1024;

const readEnvFile = async (file: string) => {
	const text = await readFile(file, 'utf8').catch(() => '');
	const values = new Map<string, string>();
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const separator = trimmed.indexOf('=');
		if (separator <= 0) continue;
		values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, ''));
	}
	return values;
};

const machineIdentity = async () => {
	for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
		const value = (await readFile(file, 'utf8').catch(() => '')).trim();
		if (value) return value;
	}
	const host = hostname().trim();
	return host || crypto.randomUUID();
};

const parseWorkerId = (value: string | undefined) => {
	if (!value || !/^\d{1,4}$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isInteger(parsed) && parsed >= 0 && parsed < WORKER_ID_SPACE ? parsed : undefined;
};

export const resolveWorkerId = async (envFile: string, environment: NodeJS.ProcessEnv = process.env) => {
	const fromEnvironment = parseWorkerId(environment[WORKER_ID_KEY]);
	if (fromEnvironment !== undefined) return fromEnvironment;
	const stored = parseWorkerId((await readEnvFile(envFile)).get(WORKER_ID_KEY));
	if (stored !== undefined) return stored;
	// 哈希后取模，而不是直接对 UUID 取模：machine-id 是十六进制串，直接按数值取模会让
	// 大量机器落在相邻的号上。
	const digest = createHash('sha256').update(await machineIdentity()).digest();
	const workerId = digest.readUInt32BE(0) % WORKER_ID_SPACE;
	// 追加而不是重写：`.env` 里可能有别的配置，整份写回会把注释和顺序一起弄丢。
	await appendFile(envFile, `${WORKER_ID_KEY}=${workerId}\n`).catch(() => undefined);
	return workerId;
};
