import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// 首页必须公开说明应用用途：外部身份源（Google 等）在应用验证时会检查这一点。
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-home-page-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';

try {
	const { app } = await import(`../dist/server.mjs?home-page=${Date.now()}`);
	const database = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	database.prepare("INSERT INTO global_site_hosts (key, hostname, site_key, status, created_at) VALUES (lower(hex(randomblob(16))), 'accounts.test','passport','enabled',?)").run(Date.now());
	// 联系邮箱来自站点设置；没配置时首页只显示“站点管理员”，Google 应用验证要求给出可联系的方式。
	// 三条站点配置由 seedBaseDatabase 建成空行（这样第一次保存也走审批），种子因此改值而不是插行。
	database.prepare("UPDATE base_configs SET value = ? WHERE name = 'site_frontend'")
		.run(JSON.stringify({ contactEmail: 'contact@example.com' }));
	database.close();

	// 站点首页说明由后端下发，未登录也能读取。
	const base = await (await app.request('http://localhost/api/home.php')).json();
	assert.ok(base.home.summary.length > 10);
	assert.deepEqual(base.home.links.map((link) => link.url), ['/page/privacy.html', '/page/terms.html']);

	// Accounts 站点覆盖成账号服务的用途说明，覆盖登录方式、账号管理、统一登录和数据使用。
	const accounts = await (await app.request('http://accounts.test/api/home.php')).json();
	// 首页显示的应用名称必须唯一且等于站点名称，Google 同意屏幕要配置同一个名字。
	// 站点名称从站点记录读取：accounts.test 的公开文档由 wwwroot/passport/index.html 静态覆盖，
	// 品牌文案手工维护，不再经过通用外壳，因此不能从文档里取 siteName。
	const siteNameDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const accountsSiteName = siteNameDatabase.prepare("SELECT title FROM global_sites WHERE key = 'passport'").get()?.title;
	siteNameDatabase.close();
	assert.equal(accounts.home.title, accountsSiteName);
	assert.match(accounts.home.summary, /统一账号服务/);
	assert.deepEqual(accounts.home.sections.map((section) => section.key), ['sign-in', 'account', 'sso', 'privacy', 'contact']);
	assert.match(accounts.home.sections.find((section) => section.key === 'privacy').body, /Google API 服务用户数据政策/);
	assert.match(accounts.home.sections.find((section) => section.key === 'contact').body, /anonymous@gmail\.com/);

	// 登录入口统一由页头弹窗提供，首页不再保留整页登录链接。
	assert.deepEqual(accounts.home.links.map((link) => [link.key, link.url]), [
		['privacy', '/page/privacy.html'],
		['terms', '/page/terms.html'],
	]);
	// 初始管理员还没创建时，任何站点都给出创建入口，这条规则对所有站点一致。
	// API 页面启动（CDN 模式）下 auth 不嵌在文档里，与客户端一样从上下文接口取。
	const readAuth = async () => (await (await app.request('http://accounts.test/api/home.php?include=auth', { headers: { accept: 'application/json' } })).json()).context.auth;
	const accountsAuth = await readAuth();
	assert.deepEqual(accountsAuth.actions.map((action) => [action.key, action.action]), [['/sign', 'local-login'], ['/sign-up', 'navigate']]);
	// 建好初始管理员后入口消失：判断依据是本站数据库的引导状态，不是站点标识。
	assert.equal((await app.request('http://localhost/api/sign.php', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_name: 'homeadmin', password: 'test-password-123' }) })).status, 201);
	const claimedAuth = await readAuth();
	assert.deepEqual(claimedAuth.actions.map((action) => [action.key, action.action]), [['/sign', 'local-login']]);

	// 不执行脚本时也能读到用途说明和隐私政策链接。
	// accounts.test 的公开文档由 wwwroot/passport/index.html 静态覆盖，用途说明写在 meta 与正文里，
	// 不再使用通用外壳的 noscript 兜底。描述以品牌名开头，用途说明紧随其后。
	const html = await (await app.request('http://accounts.test/', { headers: { accept: 'text/html' } })).text();
	assert.match(html, /<meta name="description" content="[^"]*统一账号服务：/);
	assert.match(html, /统一账号服务/);
	assert.match(html, /\/page\/privacy\.html/);

	// 首页不需要登录即可访问。
	const anonymous = await app.request('http://accounts.test/', { headers: { accept: 'text/html' } });
	assert.equal(anonymous.status, 200);

	console.log('home page test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
