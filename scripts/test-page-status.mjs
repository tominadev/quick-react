import assert from 'node:assert/strict';
import { readPageContext } from './page-context.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-page-status-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app } = await import(`../dist/server.mjs?page-status=${Date.now()}`);
	const deviceKey = '00000000-0000-4000-8000-000000000001';
	const fingerprintData = JSON.stringify({ canvas_cyrb53: '4b5a6c7d8e9f', audio_cyrb53: '1a2b3c4d5e6f' });
	const request = async (path, options = {}) => {
		const headers = new Headers(options.headers);
		if (!headers.has('x-device-key')) headers.set('x-device-key', deviceKey);
		if (!headers.has('x-device-fingerprint')) headers.set('x-device-fingerprint', fingerprintData);
		if (options.cookie) headers.set('cookie', options.cookie);
		if (options.body !== undefined) headers.set('content-type', 'application/json');
		return app.request(`http://localhost${path}`, {
			method: options.method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			redirect: 'manual',
		});
	};
	/** 后台的写入一律进审批队列（§11.3）；这些用例验的是业务行为本身，批掉再往下走。 */
	const approvePending = async (cookie) => {
		const pending = await (await request('/api/panel/admin/base/audits.php?include=data&review_status=pending', { cookie })).json();
		const ids = (pending.table?.dataSource ?? []).map((row) => String(row.id));
		if (ids.length) await request('/api/panel/admin/base/audits.php?action=approve', { method: 'POST', cookie, body: ids });
	};

	// API 页面启动（CDN 模式）下文档对所有访客一致以便缓存：HTTP 一律 200，
	// 404 / 401 等页面状态改由上下文接口下发，客户端据此渲染。断言因此看 pageStatus 而不是状态码。
	const document = async (path, options = {}) => {
		const response = await request(path, { ...options, headers: { ...options.headers, accept: 'text/html' } });
		if (response.status === 302) return { response, body: '', pageStatus: undefined };
		const page = await readPageContext(app, 'localhost', path, { cookie: options.cookie, headers: { 'x-device-key': deviceKey, 'x-device-fingerprint': fingerprintData } });
		return { response, body: page.document, pageStatus: page.context.pageStatus };
	};

	// 未登录访问不存在的路径。
	const missing = await document('/no-such-page.html');
	assert.equal(missing.pageStatus.status, 404);
	assert.equal(missing.pageStatus.status, 404);
	assert.equal(missing.pageStatus.title, '页面不存在');
	// 文案不再嵌在文档里（CDN 模式的壳对所有页面一致），由上面的 pageStatus.title 断言覆盖。
	assert.match(missing.pageStatus.description, /no-such-page/);

	// 未登录访问需要登录的路径。
	const anonymousPanel = await document('/panel/admin/global/dashboard.html');
	assert.equal(anonymousPanel.pageStatus.status, 401);
	assert.equal(anonymousPanel.pageStatus.title, '请先登录');
	assert.deepEqual(anonymousPanel.pageStatus.actions.map((action) => action.key), ['/sign', '/']);
	assert.deepEqual(anonymousPanel.pageStatus.actions.map((action) => action.action), ['local-login', 'navigate']);

	// /sign 只保留 API，公开页面入口已移除。
	const removedSignPage = await document('/sign.html');
	assert.equal(removedSignPage.pageStatus.status, 404);
	assert.equal(removedSignPage.pageStatus.status, 404);

	// 公开页面正常渲染，不返回状态提示。原来的 /about 页面已经不存在，改用现有的公开页面。
	const publicPage = await document('/page/privacy.html');
	assert.equal(publicPage.response.status, 200);
	assert.equal(publicPage.pageStatus, undefined);

	// 无后缀路径是同一页面的访问别名，直接返回页面内容而不是重定向（见 AGENTS.md 的目录与别名约定）。
	const withoutSuffix = await document('/panel/user/base/me?from=test');
	assert.equal(withoutSuffix.response.status, 200);
	assert.equal(withoutSuffix.response.headers.get('location'), null);
	assert.equal(withoutSuffix.pageStatus.status, 401, '未登录访问个人中心仍然给出登录提示');

	// JSON 接口给出同样的提示，供前端路由兜底使用。
	const anonymousStatus = await (await request('/api/page-status.php?path=/panel/admin/global/dashboard')).json();
	assert.equal(anonymousStatus.pageStatus.status, 401);
	const unknownStatus = await (await request('/api/page-status.php?path=/no-such-page')).json();
	assert.equal(unknownStatus.pageStatus.status, 404);
	// 原来用 /about 验证"角色允许但无法渲染 → 500 页面暂不可用"。该页面已被移除，
	// 当前导航里也没有其它这类节点（分组节点按 404 处理），暂时没有可用的 fixture。
	// 恢复该覆盖需要先造一个有角色、无组件的导航节点。

	assert.equal((await request('/api/sign.php', { method: 'PUT', body: { user_name: 'pageadmin', password: 'test-password-123' } })).status, 201);
	const adminLogin = await request('/api/sign.php', { method: 'POST', body: { user_name: 'pageadmin', password: 'test-password-123' } });
	const adminCookie = adminLogin.headers.get('set-cookie')?.split(';')[0];
	assert.ok(adminCookie);

	// 管理员可以正常打开管理后台。
	const adminPanel = await document('/panel/admin/global/dashboard.html', { cookie: adminCookie });
	assert.equal(adminPanel.response.status, 200);
	assert.equal(adminPanel.pageStatus, undefined);

	// 建号进审批队列（§13.6）：批掉再往下走。
	assert.equal((await request('/api/panel/admin/base/users.php', {
		method: 'POST', cookie: adminCookie, body: { user_name: 'pageuser', password: 'test-password-123', roles: [], status: 'enabled' },
	})).status, 202);
	await approvePending(adminCookie);
	const userLogin = await request('/api/sign.php', { method: 'POST', body: { user_name: 'pageuser', password: 'test-password-123' } });
	const userCookie = userLogin.headers.get('set-cookie')?.split(';')[0];
	assert.ok(userCookie);

	// 已登录但角色不足。
	const forbidden = await document('/panel/admin/global/dashboard.html', { cookie: userCookie });
	assert.equal(forbidden.pageStatus.status, 403);
	assert.equal(forbidden.pageStatus.title, '无权访问');
	assert.match(forbidden.pageStatus.description, /pageuser/);
	const forbiddenStatus = await (await request('/api/page-status.php?path=/panel/admin/global/dashboard', { cookie: userCookie })).json();
	assert.equal(forbiddenStatus.pageStatus.status, 403);

	// 已登录用户访问不存在的路径仍然是 404。
	const userMissing = await document('/panel/admin/nope.html', { cookie: userCookie });
	assert.equal(userMissing.pageStatus.status, 404);
	assert.equal(userMissing.pageStatus.status, 404);

	// 个人中心对普通用户开放。
	const personal = await document('/panel/user/base/me.html', { cookie: userCookie });
	assert.equal(personal.response.status, 200);
	assert.equal(personal.pageStatus, undefined);

	console.log('page status test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
