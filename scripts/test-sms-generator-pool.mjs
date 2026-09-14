import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

/**
 * 生成器「补足到目标数」依赖的余量（生成器文档 §5.2.1）。
 *
 * 口径只有一条：**只数还能发给新用户的**。绑定过的属于某部手机，删除的进了回收站，
 * 做到一半的另报——数错任何一类，生成器要么补不够（池子见底、新用户绑不了），要么
 * 越补越多。
 */
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-sms-pool-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';
try {
	const { app } = await import(`../dist/server.mjs?sms-pool=${Date.now()}`);
	const now = Date.now();
	const sha = (value) => createHash('sha256').update(value).digest('hex');
	const seed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	seed.prepare("INSERT INTO global_site_hosts (key, hostname, site_key, status, created_at) VALUES (lower(hex(randomblob(16))), 'sms.test', 'sms', 'enabled', ?)").run(now);
	seed.prepare("INSERT INTO sms_generator_machines (key, name, title, secret_hash, secret_prefix, status, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 'mac-test', '测试机', ?, 'gen_', 'enabled', ?, ?)").run(sha('generator-secret'), now, now);
	const token = seed.prepare('INSERT INTO sms_shortcut_tokens (key, token_sha256, status, idempotency_token, deleted_at, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)');
	let serial = 0;
	const add = (status, count, deletedAt = 0) => { for (let index = 0; index < count; index += 1) token.run(sha(`t-${++serial}`), status, `task:${serial}`, deletedAt, now, now); };
	add('available', 4);
	add('bound', 2);
	add('pending', 1);
	add('available', 3, now); // 回收站里的：删掉的不能再发给新用户
	add('bound', 1, now);
	seed.close();

	const response = await app.request('http://sms.test/api/platform/shortcut-tokens.php?action=config', { headers: { authorization: 'Bearer generator-secret' } });
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.match(String(body.message_receive_url), /\/api\/shortcut\/message-receive\.php$/);
	assert.deepEqual(body.pool, { available: 4, pending: 1 }, '只数没删的 available；bound 与回收站里的都不算，pending 另报');
	// 生成器照这个算：目标 10、可用 4 → 补 6
	assert.equal(Math.max(0, 10 - body.pool.available), 6);

	console.log('sms generator pool test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
