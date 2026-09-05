import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';

// wwwroot/<hostname>/ 下的文件按域名覆盖应用页面。
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-wwwroot-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app } = await import(`../dist/server.mjs?wwwroot=${Date.now()}`);
	// 静态覆盖按站点键查目录（wwwroot/passport/），因此域名必须先登记到对应站点，
	// 否则会落到默认站点、拿不到覆盖文件。
	const database = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	database.prepare("INSERT INTO global_site_hosts (key, hostname, site_key, status, created_at) VALUES (lower(hex(randomblob(16))), 'passport.example.com','passport','enabled',?)").run(Date.now());
	database.close();
	const html = (path, host = 'passport.example.com', method) => app.request(`http://${host}${path}`, { method, headers: { accept: 'text/html' } });

	// 该域名的首页由静态文件提供，不再是应用页面。
	const home = await html('/');
	assert.equal(home.status, 200);
	assert.match(home.headers.get('content-type') ?? '', /text\/html/);
	const homeBody = await home.text();
	assert.match(homeBody, /<h1>示例账户中心<\/h1>/);
	assert.match(homeBody, /lh3\.googleusercontent\.com/);
	assert.match(homeBody, /\/page\/privacy\.html/);
	assert.equal(homeBody.includes('__INITIAL_DATA__'), false, '静态首页不应该再渲染应用');

	// 没有对应文件的路径仍然交给应用处理。
	const appPage = await html('/about.html');
	assert.equal(appPage.status, 200);
	assert.ok((await appPage.text()).includes('__INITIAL_DATA__'));

	// 其它域名不受影响。
	const otherHost = await html('/', 'localhost');
	assert.ok((await otherHost.text()).includes('__INITIAL_DATA__'));

	// 只覆盖 GET/HEAD，写操作不受影响。
	assert.equal((await html('/', 'passport.example.com', 'POST')).status, 404);

	// 目录穿越必须被拒绝。CDN 模式下未知路径返回 200 加应用外壳，因此断言内容而不是状态码——
	// 真正要保证的是站点目录之外的文件读不到。
	for (const path of ['/%2e%2e/package.json', '/%2e%2e%2f%2e%2e%2fpackage.json', '/../package.json']) {
		const escaped = await html(path);
		const body = await escaped.text();
		assert.match(escaped.headers.get('content-type') ?? '', /text\/html/, `${path} 不应返回静态文件`);
		assert.equal(body.includes('"devDependencies"'), false, `不应该读到站点目录之外的文件：${path}`);
		assert.equal(body.includes('"quick-react"'), false, `不应该读到站点目录之外的文件：${path}`);
	}

	console.log('wwwroot override test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
