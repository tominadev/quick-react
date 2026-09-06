import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-maintenance-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app, runMaintenanceAction } = await import(`../dist/server.mjs?maintenance=${Date.now()}`);
	const headers = {
		'content-type': 'application/json',
		'x-device-key': '00000000-0000-4000-8000-000000000001',
		'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' }),
	};
	const signIn = (body) => app.request('http://localhost/api/sign.php', { method: 'POST', headers, body: JSON.stringify(body) });

	// 救援入口跑在没有请求上下文的 CLI 里，任何一处引用了已经不存在的列都会让整个工具箱
	// 报「no such column」——凭证从 base_users 拆到 base_user_credentials 时就发生过一次，
	// 而那正是 Accounts 登不进来、只能靠救援的时候。这个测试盯的就是它。
	assert.equal(await runMaintenanceAction('admin-status', {}), 'base_users.id = 1 不存在');

	assert.match(await runMaintenanceAction('restore-admin', { user_name: 'rescueadmin', password: 'rescue-password-1' }), /已恢复/);
	const status = await runMaintenanceAction('admin-status', {});
	assert.match(status, /用户名：rescueadmin/);
	assert.match(status, /角色：platform_admin/);
	assert.match(status, /本地密码：已设置/);

	// 救援设的密码必须真的能登录——这才是这个工具存在的意义。
	const first = await signIn({ user_name: 'rescueadmin', password: 'rescue-password-1' });
	assert.equal(first.status, 200);
	assert.equal((await first.json()).user.user_name, 'rescueadmin');

	assert.match(await runMaintenanceAction('set-admin-password', { password: 'rescue-password-2' }), /密码已重设/);
	assert.equal((await signIn({ user_name: 'rescueadmin', password: 'rescue-password-1' })).status, 401, '旧密码必须立即失效');
	const second = await signIn({ user_name: 'rescueadmin', password: 'rescue-password-2' });
	assert.equal(second.status, 200);
	assert.equal((await second.json()).user.user_name, 'rescueadmin');

	// 改名后仍用新名字加当前密码登录。
	assert.match(await runMaintenanceAction('set-admin-user-name', { user_name: 'rescued' }), /已设置为 rescued/);
	assert.equal((await signIn({ user_name: 'rescued', password: 'rescue-password-2' })).status, 200);

	// 用户名与密码都按统一规则校验，救援入口不是绕过校验的后门。
	await assert.rejects(runMaintenanceAction('set-admin-user-name', { user_name: 'Rescue_Admin' }), /用户名/);
	await assert.rejects(runMaintenanceAction('set-admin-password', { password: 'short' }), /密码/);

	assert.match(await runMaintenanceAction('accounts-oidc-status', {}), /Accounts OIDC 登录：关闭/);
	assert.match(await runMaintenanceAction('enable-accounts-oidc', {}), /已启用/);
	assert.match(await runMaintenanceAction('accounts-oidc-status', {}), /Accounts OIDC 登录：启用/);
	assert.match(await runMaintenanceAction('restore-accounts-oidc-defaults', {}), /已重置为默认值/);
	assert.match(await runMaintenanceAction('accounts-oidc-status', {}), /Accounts OIDC 登录：关闭/);
	await assert.rejects(runMaintenanceAction('no-such-action', {}), /未知维护动作/);

	console.log('maintenance rescue test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
