import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const projectDirectory = resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-passport-'));

try {
	const bundle = await build({
		stdin: {
			contents: `export { createSqliteAdapter } from './server/database/sqlite.mts';
				export { primeSnowflake, nextSnowflake, resetSnowflake, SNOWFLAKE_EPOCH } from './server/modules/base/snowflake.mts';
					export { confirmTelegramIdentityChoice, createTelegramIdentityChoice, issueTelegramEmailOtp, normalizePassportNickname, setPassportPassword, verifyPassportPasswordHistory, verifyTelegramEmailOtp } from './server/modules/passport/identity.mts';`,
			resolveDir: projectDirectory,
			sourcefile: 'passport-identity-test-entry.mts',
			loader: 'ts',
		},
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node22',
		write: false,
	});
	const modulePath = join(temporaryDirectory, 'passport-identity.mjs');
	await writeFile(modulePath, bundle.outputFiles[0].contents);
	const passport = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
	const databaseFile = join(temporaryDirectory, 'passport.sqlite');
	let database = passport.createSqliteAdapter(databaseFile);
	// 号段状态表在 global：发号器是全站共享设施，不再属于 passport。
	// 按目录顺序跑完，不写死文件名——迁移压成新基线时文件名会变。
	for (const site of ['global', 'passport']) {
		const directory = join(projectDirectory, 'migrations', site);
		for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
			await database.exec(await readFile(join(directory, file), 'utf8'));
		}
	}

	// 发号：一段号里连发 5000 个，互不重复，worker 位是配的那个。
	await passport.primeSnowflake(database, 7);
	const generated = Array.from({ length: 5000 }, () => BigInt(passport.nextSnowflake()));
	assert.equal(new Set(generated.map(String)).size, generated.length);
	assert.ok(generated.every((id) => ((id >> 12n) & 0x3ffn) === 7n));
	const maximumBeforeRestart = generated.reduce((maximum, id) => id > maximum ? id : maximum, 0n);
	// 重启：号段状态留在库里，重新备段只会往后走，不会把发过的号再发一遍。
	database.close();
	database = passport.createSqliteAdapter(databaseFile);
	passport.resetSnowflake();
	await passport.primeSnowflake(database, 7);
	assert.ok(BigInt(passport.nextSnowflake()) > maximumBeforeRestart);
	// 时钟回拨：库里已经预留到了未来，那就从未来接着发，不会与已经发出去的号重合。
	await database.prepare(`INSERT INTO global_snowflake_state (created_at, updated_at, worker_id, last_timestamp)
		VALUES (?1, ?2, ?3, ?4)`).bind(Date.now(), Date.now(), 8, Date.now() + 60_000).run();
	passport.resetSnowflake();
	await passport.primeSnowflake(database, 8);
	const rollbackSafe = BigInt(passport.nextSnowflake());
	assert.ok(Number((rollbackSafe >> 22n) + passport.SNOWFLAKE_EPOCH) > Date.now());
	passport.resetSnowflake();
	await passport.primeSnowflake(database, 7);

	const firstIdentity = { botId: '1', telegramUserId: '9000000001', chatId: '9000000001', nickname: 'Very Long Telegram Nickname' };
	// 外部昵称按半角宽度截断：全角记 2，ASCII 昵称因此截到 16 个字符。
	assert.equal(passport.normalizePassportNickname(firstIdentity.nickname, firstIdentity.telegramUserId), 'Very Long Telegr');
	assert.equal(passport.normalizePassportNickname('张三李四王五赵六孙七', firstIdentity.telegramUserId), '张三李四王五赵六');
	// 截断后仍不足 4 个半角就回落到 TG 兜底名。
	assert.match(passport.normalizePassportNickname('a', firstIdentity.telegramUserId), /^TG\d+$/);
	const firstOtp = await passport.issueTelegramEmailOtp(database, firstIdentity, 'First@Example.com');
	assert.equal((await passport.verifyTelegramEmailOtp(database, firstIdentity, '000000')).status, 'invalid');
	const created = await passport.verifyTelegramEmailOtp(database, firstIdentity, firstOtp.code);
	assert.equal(created.status, 'created');
	assert.match(created.userId, /^\d+$/);

	await assert.rejects(passport.issueTelegramEmailOtp(database, firstIdentity, 'second@example.com'), (error) => error?.waitSeconds > 0);
	await database.prepare(`UPDATE passport_email_otp SET created_at = created_at - 61000 WHERE bot_id = ?1 AND telegram_user_id = ?2`)
		.bind(firstIdentity.botId, firstIdentity.telegramUserId).run();
	const secondEmailOtp = await passport.issueTelegramEmailOtp(database, firstIdentity, 'second@example.com');
	const linked = await passport.verifyTelegramEmailOtp(database, firstIdentity, secondEmailOtp.code);
	assert.deepEqual(linked, { status: 'linked', userId: created.userId });

	const conflictingIdentity = { botId: '1', telegramUserId: '9000000002', chatId: '9000000002', nickname: '' };
	const conflictingOtp = await passport.issueTelegramEmailOtp(database, conflictingIdentity, 'first@example.com');
	const conflict = await passport.verifyTelegramEmailOtp(database, conflictingIdentity, conflictingOtp.code);
	assert.deepEqual(conflict, { status: 'conflict', emailUserId: created.userId });
	assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM passport_users').first()).count, 1);
	const choice = await passport.createTelegramIdentityChoice(database, conflictingIdentity, created.userId, 'first@example.com');
	const confirmed = await passport.confirmTelegramIdentityChoice(database, conflictingIdentity, choice.id);
	assert.deepEqual(confirmed, { status: 'linked', userId: created.userId });
	assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM passport_telegram_accounts WHERE user_key = ?1').bind(created.userId).first()).count, 2);

	await passport.setPassportPassword(database, created.userId, 'first-password');
	await passport.setPassportPassword(database, created.userId, 'second-password');
	assert.equal((await passport.verifyPassportPasswordHistory(database, created.userId, 'second-password')).status, 'current');
	assert.equal((await passport.verifyPassportPasswordHistory(database, created.userId, 'first-password')).status, 'old');
	assert.equal((await passport.verifyPassportPasswordHistory(database, created.userId, 'wrong-password')).status, 'invalid');
	database.close();
	console.log('passport identity test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
