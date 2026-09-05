import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const projectDirectory = resolve(import.meta.dirname, '..');

/**
 * 状态筛选走真实 HTTP，而不是只对源码做正则匹配。
 *
 * 地址栏 `?q.review_status=all` 会被前端去掉 `q.` 前缀发成 `review_status=all`，因此这里
 * 请求的参数名就是 `review_status`。参数缺失要回落到默认值「待审批」——否则下拉框显示待审批、
 * 列表却是全部。
 */
const auditRouteFilter = async () => {
	const directory = await mkdtemp(join(tmpdir(), 'quick-react-audit-route-'));
	const previousFile = process.env.DEFAULT_DATABASE_FILE;
	process.env.DEFAULT_DATABASE_FILE = join(directory, 'default.sqlite');
	process.env.SKIP_SERVER_LISTEN = '1';
	try {
		const { app, runMaintenanceAction } = await import(`../dist/server.mjs?audit-route=${Date.now()}`);
		await runMaintenanceAction('restore-admin', { user_name: 'auditadmin', password: 'audit-password-1' });
		const { DatabaseSync } = await import('node:sqlite');
		const seed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const at = Date.now();
		// 审批状态与数据状态是两列：待审批的数据从未写入，批准过的才是已生效。
		for (const [id, review, data] of [['1', 'pending', 'unwritten'], ['2', 'approved', 'applied'], ['3', 'rejected', 'unwritten'], ['4', 'pending', 'unwritten']]) {
			seed.prepare('INSERT INTO base_approvals (key, created_at,updated_at,operation_id,reason,table_name,row_id,action,changes,review_status,data_status) VALUES (lower(hex(randomblob(16))), ?,?,?,?,?,?,?,?,?,?)')
				.run(at, at, id, `理由${id}`, 'base_users', id, 'update', '{}', review, data);
		}
		seed.close();
		const headers = {
			'content-type': 'application/json',
			'x-device-key': '00000000-0000-4000-8000-000000000001',
			'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: 'a', audio_cyrb53: 'b' }),
		};
		const login = await app.request('http://localhost/api/sign.php', { method: 'POST', headers, body: JSON.stringify({ user_name: 'auditadmin', password: 'audit-password-1' }) });
		const cookie = login.headers.get('set-cookie')?.split(';')[0];
		const statuses = async (query) => {
			const response = await app.request(`http://localhost/api/panel/admin/base/audit.php?include=schema,data${query}`, { headers: { ...headers, cookie } });
			return (await response.json()).table.dataSource.map((row) => row.review_status).sort();
		};
		// 三个筛选都不预设默认值：参数缺失就是「全部」。「待审批」当过默认值，问题是它把
		// 这一页从「变更记录」悄悄变成了「待办列表」——刚提交完想确认记下来没有，翻半天以为没记。
		assert.deepEqual(await statuses(''), ['approved', 'pending', 'pending', 'rejected'], '参数缺失就是全部');
		assert.deepEqual(await statuses('&review_status=pending'), ['pending', 'pending']);
		assert.deepEqual(await statuses('&review_status=approved'), ['approved']);
		// 这就是 /panel/admin/base/audit.html?q.review_status=all 实际发出的请求。
		assert.deepEqual(await statuses('&review_status=all'), ['approved', 'pending', 'pending', 'rejected'], 'review_status=all 要返回全部');
		// 数据状态是另一条轴：待审批与被驳回的申请都停在「未写入」。
		assert.deepEqual(await statuses('&review_status=all&data_status=unwritten'), ['pending', 'pending', 'rejected']);

		// 总数要跟着筛选条件走，而且不能拿列表长度充数——列表有 200 条上限，
		// 库里更多时那样会谎报「共 200 条」。
		const totals = async (query) => {
			const response = await app.request(`http://localhost/api/panel/admin/base/audit.php?include=schema,data${query}`, { headers: { ...headers, cookie } });
			const body = await response.json();
			return { total: body.table.totalRecords, rows: body.table.dataSource.length };
		};
		assert.deepEqual(await totals('&review_status=all'), { total: 4, rows: 4 });
		assert.deepEqual(await totals('&review_status=approved'), { total: 1, rows: 1 }, '总数要跟着筛选走');
		assert.deepEqual(await totals(''), { total: 4, rows: 4 }, '参数缺失就是全部');
		const overflow = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const now = Date.now();
		for (let index = 0; index < 250; index += 1) {
			overflow.prepare('INSERT INTO base_approvals (key, created_at,updated_at,operation_id,reason,table_name,row_id,action,changes,review_status,data_status) VALUES (lower(hex(randomblob(16))), ?,?,?,?,?,?,?,?,?,?)')
				.run(now, now, `bulk${index}`, '批量', 'base_users', String(index), 'update', '{}', 'pending', 'unwritten');
		}
		overflow.close();
		const capped = await totals('&review_status=pending');
		assert.equal(capped.rows, 200, '列表仍按上限返回');
		assert.equal(capped.total, 252, '总数是真实条数，不是取回的条数');

		// 待审批的修改要在页面上看得见、也动得了：进了队列却什么都看不出来的话，
		// 表单显示的仍是旧值，用户以为没保存成功，于是再改一次，队列里堆出第二条。
		const settings = 'http://localhost/api/panel/admin/base/settings/site-frontend.php';
		const put = (body) => app.request(settings, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify(body) });
		// 三条站点配置在建库时就是空行（否则第一次保存是 INSERT，新增不留痕、也就免了审批），
		// 所以这一次同样进队列；先批掉它，后面那次才有前值可比。
		await put({ footer: '页脚甲', __changedFields: ['footer'] });
		await app.request(`${settings}?action=approve-pending`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' });
		assert.equal((await put({ footer: '页脚乙', __changedFields: ['footer'] })).status, 202, '不勾立即生效就进审批队列');
		const pendingPage = await (await app.request(settings, { headers: { ...headers, cookie } })).json();
		// 提示块是独立的一块，不是塞进页面描述里：它要显眼，还要把按钮放在内容旁边。
		assert.match(pendingPage.formPage.notice.title, /有 1 项修改正在等待审批/);
		assert.match(pendingPage.formPage.notice.lines.join('\n'), /value\.footer：页脚甲 → 页脚乙/, '提示里要写清改了什么');
		assert.deepEqual(pendingPage.formPage.notice.actions.map((action) => action.key), ['withdraw-pending', 'approve-pending', 'reject-pending']);
		assert.equal(pendingPage.currentValues.footer, '页脚甲', '还没批准，页面上仍是旧值');
		assert.equal((await app.request(`${settings}?action=approve-pending`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' })).status, 200);
		const approved = await (await app.request(settings, { headers: { ...headers, cookie } })).json();
		// 批准是直接写回表的，绕过了 configStore 那条会清缓存的路；不清缓存的话这里还是旧值。
		assert.equal(approved.currentValues.footer, '页脚乙', '批准后要立刻生效，不能被配置缓存挡住');
		assert.equal(approved.formPage.notice, undefined);
		// 撤回只收回申请，数据一动不动。
		await put({ footer: '页脚丙', __changedFields: ['footer'] });
		assert.equal((await app.request(`${settings}?action=withdraw-pending`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' })).status, 200);
		const withdrawn = await (await app.request(settings, { headers: { ...headers, cookie } })).json();
		assert.equal(withdrawn.currentValues.footer, '页脚乙', '撤回不改数据');
		assert.equal(withdrawn.formPage.notice, undefined);

		// 四个设置页共用同一个模板，别的页也得有同样的提示和动作：之前只有站点设置接了，
		// 另外三页改了什么在等审批，页面上一点都看不出来。
		const systemSettings = 'http://localhost/api/panel/admin/base/settings/system-config.php';
		const putSystem = (domain) => app.request(systemSettings, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ domain, __changedFields: ['domain'] }) });
		await putSystem('unified-jia.example');
		assert.equal((await putSystem('unified-yi.example')).status, 202, '系统配置也要进审批队列');
		const systemPage = await (await app.request(systemSettings, { headers: { ...headers, cookie } })).json();
		assert.match(systemPage.formPage.notice.title, /有 1 项修改正在等待审批/, '系统配置页也要显示待审批提示');
		assert.match(systemPage.formPage.notice.lines.join('\n'), /unified-jia\.example → unified-yi\.example/);
		assert.deepEqual(systemPage.formPage.notice.actions.map((action) => action.key), ['withdraw-pending', 'approve-pending', 'reject-pending']);
		assert.equal((await app.request(`${systemSettings}?action=approve-pending`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' })).status, 200);
		const systemApproved = await (await app.request(systemSettings, { headers: { ...headers, cookie } })).json();
		assert.equal(systemApproved.currentValues.domain, 'unified-yi.example', '批准后系统配置也要立刻生效');
		assert.equal(systemApproved.formPage.notice, undefined);

		// TableCRUD 一律通用：有修改在等审批的行会被标出来，并挂上撤回与立即批准。
		// 先清掉上面为测总数塞的假记录：它们的 table_name 也是 base_users、row_id 是 0..249，
		// 会和新建账号的 id 撞上，让这一段测到的是那些假记录。
		const cleanup = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		cleanup.prepare("DELETE FROM base_approvals WHERE changes = '{}'").run();
		cleanup.close();
		const usersApi = 'http://localhost/api/panel/admin/base/users.php';
		// 建号也进审批队列（§13.6），三行共享一个操作号；先批掉，后面验的是「改」不是「建」。
		await app.request(usersApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'pendingbob', password: 'bob-password-123', roles: [], status: 'enabled' }) });
		{
			const queued = await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json();
			const ids = queued.table.dataSource.map((row) => String(row.id));
			// 只批一条：同一个操作号的其余记录会跟着一起生效——只批账号那一行，
			// 得到的是「能登录但没有密码」。
			assert.equal((await app.request('http://localhost/api/panel/admin/base/audit.php?action=approve', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify(ids.slice(0, 1)) })).status, 200);
			const left = await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json();
			assert.equal(left.table.dataSource.length, 0, '同一次操作的记录要一起批准');
		}
		const listBefore = await (await app.request(`${usersApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
		const bob = listBefore.table.dataSource.find((row) => row.user_name === 'pendingbob');
		assert.ok(bob, '新建的账号应该在列表里');
		assert.equal((await app.request(`${usersApi}/${bob.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ status: 'disabled', __changedFields: ['status'] }) })).status, 202);
		const marked = await (await app.request(`${usersApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
		assert.equal(marked.table.columns.some((column) => column.dataIndex === '_pending'), false, '不开「审批」列：标记是数据不是列，前端拿它给那一行换底色');
		assert.equal(marked.table.dataSource.find((row) => row.user_name === 'pendingbob')._pending, '1');
		assert.deepEqual(
			marked.table.option.actions.row.slice(-2).map((action) => action.key),
			['withdraw-pending', 'approve-pending'],
		);
		assert.equal(marked.table.dataSource.find((row) => row.user_name === 'pendingbob').status, 'enabled', '还没批准就不该生效');
		assert.equal((await app.request(`${usersApi}/${bob.id}?action=approve-pending`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' })).status, 200);
		const applied = await (await app.request(`${usersApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
		assert.equal(applied.table.dataSource.find((row) => row.user_name === 'pendingbob').status, 'disabled');
		assert.equal(applied.table.dataSource.find((row) => row.user_name === 'pendingbob')._pending, '', '批完标记要清掉');

		// ---- 新建也进审批队列 ----
		// 行照写进库，但 pended_at 非零让它对所有正常查询不可见；批准把它归零，
		// 驳回把那一行物理删掉——它从未生效过，历史留在这条审批记录上。
		const rowsApi = 'http://localhost/api/panel/admin/base/data/rows.php?table=base_configs';
		// 数据管理**不过滤 pended_at**：它看的是表里实际有什么。所以「生效的行」在这里要
		// 自己按 pended_at 收一次——顺带证明待审批的那一行确实躺在库里，只是还没生效。
		const configRows = async () => (await (await app.request(`${rowsApi}&include=data`, { headers: { ...headers, cookie } })).json()).table.dataSource;
		const visibleKeys = async () => (await configRows()).filter((row) => String(row.pended_at) === '0').map((row) => row.key);
		const pendedKeys = async () => (await configRows()).filter((row) => String(row.pended_at) !== '0').map((row) => row.key);
		const pendingIds = async () => (await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json())
			.table.dataSource.map((row) => String(row.id));
		const decide = (action, ids) => app.request(`http://localhost/api/panel/admin/base/audit.php?action=${action}`, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify(ids) });

		assert.equal((await app.request(rowsApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ key: 'audit_fixture', value: '{}' }) })).status, 202, '新建也要进审批队列');
		assert.equal((await visibleKeys()).includes('audit_fixture'), false, '没批准之前这一行不该生效');
		assert.equal((await pendedKeys()).includes('audit_fixture'), true, '但它躺在库里，数据管理看得见');
		const insertEntry = (await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json())
			.table.dataSource.find((row) => row.row_key === 'audit_fixture');
		assert.equal(insertEntry.action, 'insert');
		assert.equal(insertEntry.data_status, 'unwritten');
		// changes 留空：值就在行上，抄进审批表反而要把隐藏列一并搬进去。
		assert.equal(insertEntry.summary, '');
		assert.equal((await decide('approve', [String(insertEntry.id)])).status, 200);
		assert.equal((await visibleKeys()).includes('audit_fixture'), true, '批准之后这一行才开始存在');

		// 撞唯一索引不该在队列里留下孤儿。
		//
		// 新建是「行照写、pended_at 非零」，所以唯一索引在**提交那一刻**就会拦下来；而审批
		// 记录是先写的。不清理的话，队列里会留下一条指向从未写成的行的申请——批也批不动，
		// 界面上却像是有人在等审批。顺带：撞唯一索引是 409，不是 500。
		const queuedBefore = (await pendingIds()).length;
		const duplicate = await app.request(rowsApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ key: 'audit_fixture', value: '{}' }) });
		assert.equal(duplicate.status, 409, '重复的 key 是用户输入的正常结果，不是服务端故障');
		assert.equal((await pendingIds()).length, queuedBefore, '失败的新建不该在队列里留下申请');

		// 驳回：那一行物理消失。
		assert.equal((await app.request(rowsApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ key: 'audit_rejected', value: '{}' }) })).status, 202);
		assert.equal((await decide('reject', await pendingIds())).status, 200);
		assert.equal([...await visibleKeys(), ...await pendedKeys()].includes('audit_rejected'), false, '驳回之后行不该留下，数据管理里也不该有');
		const leftovers = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		assert.equal(leftovers.prepare("SELECT COUNT(*) AS n FROM base_configs WHERE key = 'audit_rejected'").get().n, 0, '被驳回的新建要物理删掉，不是留在回收站');
		leftovers.close();

		// 一次操作里的几行有先后：建起来从账号开始，拆掉反着来（先资料后账号）——
		// 中间那一刻不能出现「凭证指向一个已经不存在的账号」。
		assert.equal((await app.request(usersApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'rejectme', password: 'reject-password-1', roles: [], status: 'enabled', profile_nickname: '要被驳回' }) })).status, 202);
		// 管理后台的列表**看得见**待审批的新行，并且带上「待审批」标记和撤回/批准两个动作——
		// 看不见的话，提交的人以为没保存成功，审批的人也没地方点。
		const pendingList = await (await app.request(`${usersApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
		const queuedRow = pendingList.table.dataSource.find((row) => row.user_name === 'rejectme');
		assert.ok(queuedRow, '待审批的新账号要出现在用户管理里');
		assert.equal(queuedRow._pending, '1', '并且标成待审批');
		// 不为它开一列：`_pending` 是数据不是列，前端拿它给那几行换底色。
		assert.equal(pendingList.table.columns.some((column) => column.dataIndex === '_pending'), false, '不该多出一列');
		const rowActions = pendingList.table.option.actions.row.map((action) => action.key);
		assert.ok(rowActions.includes('withdraw-pending') && rowActions.includes('approve-pending'), '行上要有撤回和批准');
		// 写操作之后前端只取 data，用缓存的表结构。那次响应照样要带上 _pending，
		// 否则删一行之后得整页刷新才看得见「撤回申请」。
		const dataOnly = await (await app.request(`${usersApi}?include=data`, { headers: { ...headers, cookie } })).json();
		assert.equal('option' in dataOnly.table, false, '只请求数据时不该下发结构');
		assert.equal(dataOnly.table.dataSource.find((row) => row.user_name === 'rejectme')?._pending, '1', '只取数据也要带标记');
		const queuedInsert = await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json();
		assert.equal(queuedInsert.table.dataSource.length, 3, '建号写三行：账号、凭证、资料');
		assert.equal(new Set(queuedInsert.table.dataSource.map((row) => row.operation_id)).size, 1, '三条共享一个操作号');
		assert.equal((await app.request('http://localhost/api/panel/admin/base/audit.php?action=reject', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify([String(queuedInsert.table.dataSource[0].id)]) })).status, 200);
		const afterReject = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		assert.equal(afterReject.prepare("SELECT COUNT(*) AS n FROM base_users WHERE name = 'rejectme'").get().n, 0, '驳回要把账号那一行删掉');
		assert.equal(afterReject.prepare('SELECT COUNT(*) AS n FROM base_user_credentials WHERE user_id NOT IN (SELECT id FROM base_users)').get().n, 0, '驳回不能留下指向不存在账号的凭证');
		assert.equal(afterReject.prepare('SELECT COUNT(*) AS n FROM base_user_profiles WHERE user_id NOT IN (SELECT id FROM base_users)').get().n, 0, '资料同理');
		afterReject.close();

		// 列的先后要与 prisma 里的字段顺序一致：两处对照着看时不用来回找。
		// 只比相对次序——不是每个字段都显示（operation_id 就不显示），也允许有计算列。
		const schema = await readFile(resolve(projectDirectory, 'prisma/base.prisma'), 'utf8');
		const model = /model base_approvals \{([\s\S]*?)\n\}/.exec(schema);
		assert.ok(model, '找不到 base_approvals 模型');
		const schemaOrder = [...model[1].matchAll(/^\s{2}([a-z_]+)\s+\S/gm)].map((match) => match[1]);
		const listed = (await (await app.request('http://localhost/api/panel/admin/base/audit.php?include=schema,data', { headers: { ...headers, cookie } })).json()).table.columns
			.map((column) => column.dataIndex)
			.filter((dataIndex) => schemaOrder.includes(dataIndex));
		assert.deepEqual(listed, schemaOrder.filter((column) => listed.includes(column)), '后台列的先后必须与 prisma 字段顺序一致');

		// 操作的来源域名与接口路径要记进审计：多站点共用一套代码，只记「改了什么」
		// 而不记「在哪改的」，事后分不清是哪个站点的管理员动的手。
		await app.request('https://site-a.test/api/panel/me.php', { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ _section: 'profile', profile_nickname: '甲甲', profile_qq: '', profile_wechat: '', profile_email: '' }) });
		await app.request('https://site-b.test/api/panel/me.php', { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ _section: 'profile', profile_nickname: '乙乙', profile_qq: '', profile_wechat: '', profile_email: '' }) });
		const origins = await app.request('http://localhost/api/panel/admin/base/audit.php?include=schema,data&review_status=all&table_name=base_user_profiles', { headers: { ...headers, cookie } });
		const originRows = (await origins.json()).table.dataSource;
		assert.ok(originRows.length >= 1, '改昵称要留下审计记录');
		// 记的是去掉后缀的逻辑路径：`.php` 是站点可配的接口后缀，记原样会让同一件事
		// 在审计里长出好几种写法，按路径筛选也就筛不干净。
		// 只看「改」：建号也会写一条资料行，那一条的来路是后台的建号接口，不是个人中心。
		assert.deepEqual([...new Set(originRows.filter((row) => row.action === '修改').map((row) => row.request_path))], ['/api/panel/me']);
		assert.ok(originRows.some((row) => row.request_hostname === 'site-b.test'), '域名要如实记下来，而不是都记成同一个');
		// 域名与接口路径由服务端自己看到，不听客户端的：页面路径要靠 referer 推断，
		// 那是客户端说什么就是什么，写进审计等于给伪造留了口子。
		const operation = await readFile(resolve(projectDirectory, 'server/modules/base/operation.mts'), 'utf8');
		assert.match(operation, /new URL\(c\.req\.url\)/);
		assert.doesNotMatch(operation, /request_path: [^,\n]*referer/i);

	} finally {
		if (previousFile === undefined) delete process.env.DEFAULT_DATABASE_FILE;
		else process.env.DEFAULT_DATABASE_FILE = previousFile;
		await rm(directory, { recursive: true, force: true });
	}
};
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-change-audit-'));
try {
	const result = await build({
		stdin: {
			contents: "export * from './server/database/sql.mts'; export * from './server/database/sqlite.mts'; export * from './server/database/index.mts'; export * from './server/modules/base/operation.mts'; export * from './server/modules/base/audit.mts'; export { useMemorySnowflake } from './server/modules/base/snowflake.mts';",
			resolveDir: projectDirectory, sourcefile: 'audit-test-entry.mts',
		},
		bundle: true, format: 'esm', platform: 'node', write: false,
	});
	const moduleFile = join(temporaryDirectory, 'audit.mjs');
	await writeFile(moduleFile, result.outputFiles[0].contents);
	const { useMemorySnowflake, allSql, createSqliteAdapter, firstSql, parseAuditChanges, publicAuditChanges, purgeAuditRetention, purgeExpiredAuditEntries, transitionAuditEntries, runOperationSql, runSql, sql, withDatabaseActors } = await import(pathToFileURL(moduleFile));
	// 单元测试不连库，用内存号段：生产路径一律走 primeSnowflake，那里的原子预留才防得住重启和多进程。
	useMemorySnowflake();

	const database = createSqliteAdapter(join(temporaryDirectory, 'audit.sqlite'));
	const migrations = resolve(projectDirectory, 'migrations/base');
	for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
		await database.exec(await readFile(resolve(migrations, file), 'utf8'));
	}

	// 统计准备的语句，用来验证不该留痕的写入不产生额外读取。
	let prepared = [];
	const counting = { ...database, prepare: (query) => { prepared.push(query); return database.prepare(query); } };
	const reset = () => { prepared = []; };
	// 后台请求拿到的适配器：绑定了主体，并且标记为人工操作。
	const acting = withDatabaseActors(counting, { subjectRoles: ['platform_admin'], humanOperation: true });
	// runOperation 只用请求上下文取「操作原因」，测试给一个最小桩。
	// 原因走 X-Change-Reason 请求头，客户端 encodeURIComponent 后再发。
	// 默认「立即生效」，绝大多数用例验的是留痕本身；审批那几条单独构造未勾选的上下文。
	// 「立即生效」的请求头已废除：管理后台的写入一律进队列，只有路由内部的机器写入
	// 可以用 options.immediate 显式声明。这些用例大多验的是记录内容本身，因此默认直写；
	// 要验排队的地方显式传 { immediate: false }。
	const context = (reason) => ({
		req: {
			path: '/api/panel/admin/base/users',
			header: (name) => name === 'x-change-reason' && reason !== undefined ? encodeURIComponent(reason) : undefined,
		},
		get: (key) => key === 'effectiveRoles' ? ['platform_admin'] : undefined,
		set: () => {},
	});
	const op = (statement, options) => runOperationSql(context(), acting, statement, { immediate: true, ...options });

	const entries = async () => (await allSql(acting, sql({ database: acting }).select({ table: 'base_approvals', includeAll: true, orderBy: [{ column: 'id', direction: 'ASC' }] }))).map((entry) => ({ ...entry, id: String(entry.id) }));
	const changesOf = (entry) => JSON.parse(entry.changes);
	const latestEntry = async () => (await entries()).at(-1);

	await runSql(acting, sql({ database: acting }).insert('base_users', { name: 'alice', roles: '[]', status: 'enabled' }));
	const alice = await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: 'alice' }] }));

	// 新增不产生审计条目（§3.0）：insert 不带元信息，因此 runSql 也不会拦它。
	assert.equal((await entries()).length, 0, '新增不应产生审计条目');

	// ---- 看门人：人工请求里的受管写入必须走操作层 ----
	await assert.rejects(
		() => runSql(acting, sql({ database: acting }).update('base_users', { name: 'x' }, { id: alice.id })),
		/必须走 runOperation/,
		'漏包 runOperation 必须立刻报错，而不是静默少一条证据',
	);
	assert.equal((await entries()).length, 0);
	// 非人工请求（登录、回调、迁移、清理）照旧直写，不受约束也不留痕。
	const machine = withDatabaseActors(counting, { subjectRoles: ['platform_admin'] });
	await runSql(machine, sql({ database: machine }).update('base_users', { name: 'by-machine' }, { id: alice.id }));
	assert.equal((await entries()).length, 0, '非人工请求的写入不留痕');
	await runSql(machine, sql({ database: machine }).update('base_users', { name: 'alice' }, { id: alice.id }));

	// ---- 记录内容 ----
	reset();
	await op(sql({ database: acting }).update('base_users', { name: 'alice-2', status: 'enabled' }, { id: alice.id }), { reason: '客户改名申请 #1024' });
	let all = await entries();
	assert.equal(all.length, 1);
	assert.equal(all[0].table_name, 'base_users');
	assert.equal(String(all[0].row_id), String(alice.id));
	assert.equal(all[0].action, 'update');
	assert.equal(all[0].review_status, 'none', '没人批过就不叫已批准');
	// 定位靠 key 不靠 row_id：row_id 是自增值，跨库搬迁后会指到别的行去。
	assert.match(String(all[0].row_key), /^\d+$/, '记录要带上那一行的 key');
	assert.equal(all[0].data_status, 'applied');
	assert.equal(all[0].scope, 'admin');
	assert.equal(all[0].reason, '客户改名申请 #1024', '操作原因要记下来——审计记了改了什么，这一列记为什么');
	assert.ok(all[0].operation_id, '每条记录都属于某一次操作');
	assert.deepEqual(changesOf(all[0]), { name: { before: 'alice', after: 'alice-2' } }, '未变化的 status 不应出现在 changes 里');
	assert.ok(prepared.some((query) => query.startsWith('SELECT')), '业务变更要读一次原行');

	// 原因随表单一起提交时从请求体里取，业务路由因此不用改签名。
	await runOperationSql(context('表单里填的原因：中文也要能过'), acting, sql({ database: acting }).update('base_users', { status: 'disabled' }, { id: alice.id }), { immediate: true });
	assert.equal((await latestEntry()).reason, '表单里填的原因：中文也要能过', '请求头里的原因要能正确解码');
	await op(sql({ database: acting }).update('base_users', { status: 'enabled' }, { id: alice.id }));

	// 提交未改动的字段不产生噪音，全部未变化时不产生记录。
	const beforeNoop = (await entries()).length;
	await op(sql({ database: acting }).update('base_users', { name: 'alice-2', status: 'enabled' }, { id: alice.id }));
	assert.equal((await entries()).length, beforeNoop, '逐列一致时不应产生记录');

	// 数组值要按驱动的绑定规则归一：写入的是数组，读回来的是 JSON 文本。
	// 不归一的话同样的值再存一次会被判成「变了」，撤回时的值校验也永远匹配不上。
	const beforeArray = (await entries()).length;
	await op(sql({ database: acting }).update('base_users', { roles: ['tenant_admin'] }, { id: alice.id }));
	const arrayEntry = await latestEntry();
	assert.equal((await entries()).length, beforeArray + 1);
	// 两边都是数组：SQLite 没有 JSON 类型是存储细节，不该漏进审计记录。
	assert.deepEqual(changesOf(arrayEntry).roles, { before: [], after: ['tenant_admin'] }, '数组列两边都记成数组');
	await op(sql({ database: acting }).update('base_users', { roles: ['tenant_admin'] }, { id: alice.id }));
	assert.equal((await entries()).length, beforeArray + 1, '同样的数组再存一次不该产生记录');
	// 同一列不能因为写入形态不同而记成两种样子：路由层传数组、「数据管理」的表单传
	// JSON 字符串，两条路径都要还原成数组。
	await op(sql({ database: acting }).update('base_users', { roles: '["branch_admin"]' }, { id: alice.id }));
	assert.deepEqual(changesOf(await latestEntry()).roles, { before: ['tenant_admin'], after: ['branch_admin'] }, '写入 JSON 字符串时同样记成数组');
	assert.equal((await transitionAuditEntries(acting, [(await latestEntry()).id], 'revert'))[0].ok, true, '写入字符串的那条也要能撤回');
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { roles: 'roles' }, where: [{ column: 'id', value: alice.id }] }))).roles, '["tenant_admin"]');
	assert.equal((await transitionAuditEntries(acting, [arrayEntry.id], 'revert'))[0].ok, true, '数组列必须能撤回');
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { roles: 'roles' }, where: [{ column: 'id', value: alice.id }] }))).roles, '[]');

	// ---- 一次操作可以包含多条写入，它们共享同一个 operation_id 与同一条原因 ----
	await runSql(acting, sql({ database: acting }).insert('base_users', { name: 'bob', roles: '[]', status: 'disabled' }));
	const bob = await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: 'bob' }] }));
	const beforeMulti = (await entries()).length;
	const { runOperation } = await import(pathToFileURL(moduleFile));
	await runOperation(context(), acting, [
		sql({ database: acting }).update('base_users', { status: 'disabled' }, { id: alice.id }),
		sql({ database: acting }).update('base_users', { status: 'enabled' }, { id: bob.id }),
	], { reason: '批量调整状态', immediate: true });
	const multi = (await entries()).slice(beforeMulti);
	assert.equal(multi.length, 2, '一次操作写两行就记两条');
	assert.equal(multi[0].operation_id, multi[1].operation_id, '同一次操作共享 operation_id');
	assert.ok(multi.every((entry) => entry.reason === '批量调整状态'));
	await op(sql({ database: acting }).update('base_users', { status: 'enabled' }, { id: alice.id }));

	// ---- 请求内的机器写入：显式声明，不留痕 ----
	const { runSystemSql } = await import(pathToFileURL(moduleFile));
	const beforeSystem = (await entries()).length;
	await runSystemSql(acting, sql({ database: acting }).update('base_users', { name: 'incidental' }, { id: bob.id }));
	assert.equal((await entries()).length, beforeSystem, 'runSystemSql 是显式声明「这不是人做的修改」');

	// ---- 软删除与恢复 ----
	await op(sql({ database: acting }).softDelete('base_users', { id: alice.id }));
	await op(sql({ database: acting }).restore('base_users', { id: alice.id }));
	all = await entries();
	assert.equal(all.at(-2).action, 'soft_delete');
	assert.equal(Number(changesOf(all.at(-2)).deleted_at.before), 0);
	assert.ok(Number(changesOf(all.at(-2)).deleted_at.after) > 0);
	assert.equal(all.at(-1).action, 'restore');
	assert.equal(Number(changesOf(all.at(-1)).deleted_at.after), 0);

	// 物理删除不产生记录。
	await runSql(acting, sql({ database: acting }).insert('base_users', { name: 'temp', roles: '[]', status: 'enabled' }));
	const beforePurgeRow = (await entries()).length;
	await runSql(acting, sql({ database: acting }).delete('base_users', { name: 'temp' }));
	assert.equal((await entries()).length, beforePurgeRow, '物理删除不应产生记录');

	// ---- 操作者与归属：created_duid 是真实操作者，owner_uid 是作用账号（§4.1）----
	const delegated = sql({ database: acting, actorUid: '77', ownerUid: '42', ownerTid: '3', ownerBid: '5' });
	await runOperationSql(context(), acting, delegated.update('base_users', { name: 'alice-3' }, { id: alice.id }), { immediate: true });
	const delegatedEntry = await latestEntry();
	assert.equal(String(delegatedEntry.created_duid), '77', 'created_duid 应是客服的 device-user');
	assert.equal(String(delegatedEntry.owner_uid), '42', 'owner_uid 应是被代查的账号');
	assert.equal(String(delegatedEntry.owner_tid), '3');
	assert.equal(String(delegatedEntry.owner_bid), '5');

	// ---- 审计写入失败时，业务写入一并失败（§6.2）----
	// 只让写入失败：读要照常，操作层现在会先查一次这个人有没有挂着的待审批记录。
	const failWrite = async () => { throw new Error('audit write failed'); };
	const failing = withDatabaseActors({
		...database,
		prepare: (query) => query.startsWith('INSERT INTO "base_approvals"') || query.startsWith('UPDATE "base_approvals"')
			? { bind: () => ({ run: failWrite, first: failWrite, all: failWrite }) }
			: database.prepare(query),
	}, { subjectRoles: ['platform_admin'], humanOperation: true });
	await assert.rejects(
		() => runOperationSql(context(), failing, sql({ database: failing }).update('base_users', { name: 'alice-4' }, { id: alice.id }), { immediate: true }),
		/audit write failed/,
		'审计写不进去时整个操作必须失败',
	);
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { name: 'name' }, where: [{ column: 'id', value: alice.id }] }))).name, 'alice-3', '审计失败后业务数据不应被改动');

	// ---- 撤回（§7）----
	const nameOf = async (id) => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { name: 'name' }, where: [{ column: 'id', value: id }], deleted: 'all' }))).name;
	const statusOf = async (entryId) => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_approvals', columns: { data_status: 'data_status' }, where: [{ column: 'id', value: entryId }] }))).data_status;
	const revert = (ids, reason = '') => transitionAuditEntries(acting, ids, 'revert', reason);
	const restore = (ids, reason = '') => transitionAuditEntries(acting, ids, 'restore', reason);
	const entryById = async (id) => (await entries()).find((entry) => entry.id === id);

	// 撤回不新开记录，而是把这一条翻到另一面。
	await op(sql({ database: acting }).update('base_users', { name: 'dave' }, { id: alice.id }));
	const daveEntry = await latestEntry();
	const beforeRevert = (await entries()).length;
	// 「恢复」按钮点在一条已生效的记录上（列表过期）：拒绝，而不是翻成相反方向。
	assert.deepEqual(await restore([daveEntry.id]), [{ id: daveEntry.id, ok: false, message: '当前数据状态是「已生效」，不能执行这个操作' }], { immediate: true });
	assert.equal(await nameOf(alice.id), 'dave', '被拒绝时数据不变');
	assert.deepEqual(await revert([daveEntry.id], '撤回理由：改错了'), [{ id: daveEntry.id, ok: true, message: '已回滚' }]);
	assert.equal(await nameOf(alice.id), 'alice-3', '撤回后字段应恢复原值');
	assert.equal(await statusOf(daveEntry.id), 'reverted');
	assert.equal((await entries()).length, beforeRevert, '撤回不产生新的审计记录');
	// 翻转的操作者、时间与理由另存三列：原记录的 created_* 属于原操作者，不能复用。
	const flipped = await entryById(daveEntry.id);
	assert.equal(flipped.revert_reason, '撤回理由：改错了');
	assert.ok(Number(flipped.reverted_at) > 0, '要记下什么时候撤的');
	assert.equal(flipped.reason, daveEntry.reason, '原操作的理由不应被覆盖');

	// 撤回错了就再翻回来，不会堆出一串互相指向的记录。
	assert.deepEqual(await revert([daveEntry.id]), [{ id: daveEntry.id, ok: false, message: '当前数据状态是「已回滚」，不能执行这个操作' }]);
	assert.deepEqual(await restore([daveEntry.id], '恢复：撤错了'), [{ id: daveEntry.id, ok: true, message: '已恢复' }]);
	assert.equal(await nameOf(alice.id), 'dave', '恢复后应回到变更后的值');
	assert.equal(await statusOf(daveEntry.id), 'applied');
	assert.equal((await entries()).length, beforeRevert, '恢复同样不产生新记录');
	// 撤回与恢复各写自己那一组：恢复不能把「谁撤的」覆盖掉。
	const afterRestore = await entryById(daveEntry.id);
	assert.equal(afterRestore.restore_reason, '恢复：撤错了');
	assert.ok(Number(afterRestore.restored_at) > 0, '要记下什么时候恢复的');
	assert.equal(afterRestore.revert_reason, '撤回理由：改错了', '恢复不能覆盖撤回理由');
	assert.ok(Number(afterRestore.reverted_at) > 0, '撤回时间要保留');
	// 再撤回一次，把数据放回后面用例期望的位置。
	assert.equal((await revert([daveEntry.id]))[0].ok, true);
	assert.equal(await nameOf(alice.id), 'alice-3');

	// 要还原的列在变更之后又被改过时，撤回被拒绝且数据不变。
	await op(sql({ database: acting }).update('base_users', { name: 'erin' }, { id: alice.id }));
	const erinEntry = await latestEntry();
	await op(sql({ database: acting }).update('base_users', { name: 'frank' }, { id: alice.id }));
	const rejected = await revert([erinEntry.id]);
	assert.equal(rejected[0].ok, false);
	assert.match(rejected[0].message, /已被后续修改覆盖/);
	assert.equal(await nameOf(alice.id), 'frank', '撤回被拒绝时数据不变');
	assert.equal(await statusOf(erinEntry.id), 'applied', '被拒绝的记录不应标记为已撤回');

	// 同一行上与本次变更无关的列被改过，不影响撤回。
	await op(sql({ database: acting }).update('base_users', { name: 'grace' }, { id: alice.id }));
	const graceEntry = await latestEntry();
	await op(sql({ database: acting }).update('base_users', { status: 'disabled' }, { id: alice.id }));
	assert.equal((await revert([graceEntry.id]))[0].ok, true, '无关列被改动不应挡住撤回');
	assert.equal(await nameOf(alice.id), 'frank');

	// 同一列的两次连续变更：倒序撤回全部成功，数据回到最初值。
	await op(sql({ database: acting }).update('base_users', { name: 'step-b' }, { id: alice.id }));
	const stepB = await latestEntry();
	await op(sql({ database: acting }).update('base_users', { name: 'step-c' }, { id: alice.id }));
	const stepC = await latestEntry();
	const chained = await revert([stepB.id, stepC.id]);
	assert.deepEqual(chained.map((r) => r.ok), [true, true], '链式变更倒序撤回应全部成功');
	assert.equal(chained[0].id, stepC.id, '执行顺序必须是从新到旧，不沿用传入顺序');
	assert.equal(await nameOf(alice.id), 'frank', '连续撤回后应回到最初值');
	// 恢复方向相反：从旧到新才走得通。
	const restored = await restore([stepC.id, stepB.id]);
	assert.deepEqual(restored.map((r) => r.ok), [true, true], '链式恢复应全部成功');
	assert.equal(restored[0].id, stepB.id, '恢复必须从旧到新');
	assert.equal(await nameOf(alice.id), 'step-c', '连续恢复后应回到最后的值');
	assert.deepEqual((await revert([stepB.id, stepC.id])).map((r) => r.ok), [true, true]);
	assert.equal(await nameOf(alice.id), 'frank');

	// 多选中某一条被拒绝时，其余条目照常执行。
	await op(sql({ database: acting }).update('base_users', { name: 'mixed' }, { id: alice.id }));
	const mixedEntry = await latestEntry();
	const mixed = await revert([mixedEntry.id, erinEntry.id]);
	assert.equal(mixed.find((r) => r.id === mixedEntry.id).ok, true);
	assert.equal(mixed.find((r) => r.id === erinEntry.id).ok, false);
	assert.equal(await nameOf(alice.id), 'frank');

	assert.deepEqual(await revert(['999999']), [{ id: '999999', ok: false, message: '审计记录不存在或无权访问' }]);

	// 撤回软删除后回到未删除；再翻回来时 deleted_at 写回**原时间戳**而不是当前时间。
	const deletedAtOf = async () => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { deleted_at: 'deleted_at' }, where: [{ column: 'id', value: alice.id }], deleted: 'all' }))).deleted_at;
	await op(sql({ database: acting }).softDelete('base_users', { id: alice.id }));
	const deleteEntry = await latestEntry();
	const deletedAt = await deletedAtOf();
	assert.equal(deleteEntry.action, 'soft_delete');
	assert.ok(Number(deletedAt) > 0);
	const beforeFlip = (await entries()).length;
	assert.equal((await revert([deleteEntry.id]))[0].ok, true);
	assert.equal(Number(await deletedAtOf()), 0, '撤回软删除后记录应回到未删除');
	assert.equal((await entries()).length, beforeFlip, '撤回软删除不产生新记录');
	assert.equal(await statusOf(deleteEntry.id), 'reverted');
	assert.equal((await restore([deleteEntry.id]))[0].ok, true);
	assert.equal(String(await deletedAtOf()), String(deletedAt), '恢复删除应写回原时间戳，而不是当前时间');
	assert.equal((await revert([deleteEntry.id]))[0].ok, true);
	assert.equal(Number(await deletedAtOf()), 0);

	// ---- 凭证列：照常记录、照常撤回，只是接口不返回值（§5）----
	// 凭证与账号资料分表；password 是 JSON 列（存 { hash, pattern }），前后值都记成对象。
	await runSql(acting, sql({ database: acting }).insert('base_user_credentials', { user_id: alice.id, password: { hash: 'hash-1', pattern: 'LLLL' } }));
	await op(sql({ database: acting }).update('base_user_credentials', { password: { hash: 'hash-2', pattern: 'LLLL' } }, { user_id: alice.id }));
	const passwordEntry = await latestEntry();
	const storedChanges = parseAuditChanges(passwordEntry.changes);
	// 只记变了的键：pattern 没变就不进记录。撤回按键合并回去，下面那条断言验证了合并结果。
	assert.deepEqual(storedChanges.password, { before: { hash: 'hash-1' }, after: { hash: 'hash-2' } }, '存储层只记变化的键，且不做加密');
	assert.deepEqual(publicAuditChanges(storedChanges), { password: { hidden: true } }, '接口不得返回凭证值');
	assert.equal((await revert([passwordEntry.id]))[0].ok, true, '凭证列仍然可以撤回');
	// 比对象而不是比 JSON 文本：键序在 JSON 里没有语义，拿文本比会为了一个无关的差别失败。
	// 撤回只写回记录里提到的键（hash），没提到的（pattern）保持当前值——这正是差异存储换来的：
	// 中途被别人改过的其他键不会被一起抹掉。
	assert.deepEqual(JSON.parse((await firstSql(acting, sql({ database: acting }).select({ table: 'base_user_credentials', columns: { password: 'password' }, where: [{ column: 'user_id', value: alice.id }] }))).password), { hash: 'hash-1', pattern: 'LLLL' }, '撤回后凭证应还原');

	// 多列一起改时，摘要一列一行，不挤在一行里。
	const { describeAuditChanges } = await import(pathToFileURL(moduleFile));
	assert.equal(
		describeAuditChanges({ name: { before: 'a', after: 'b' }, status: { before: 'enabled', after: 'disabled' } }),
		'name：a → b\nstatus：enabled → disabled',
	);
	assert.equal(describeAuditChanges({ password: { before: 'x', after: 'y' } }), 'password：已变更', '凭证列只说已变更');
	// password 也是 JSON 列，但整列隐藏的列**绝不逐键展开**——展开就等于把 password.hash
	// 明明白白写在页面上。隐藏与否先在最外层定死。
	assert.equal(
		describeAuditChanges({ password: { before: { hash: 'h1', pattern: 'LLL' }, after: { hash: 'h2', pattern: 'LLLL' } } }),
		'password：已变更',
	);
	assert.deepEqual(
		publicAuditChanges({ password: { before: { hash: 'h1' }, after: { hash: 'h2' } } }),
		{ password: { hidden: true } },
		'凭证列展开就是泄密',
	);
	// JSON 列按键求差异：改一个页脚不该甩出整块站点配置。
	assert.equal(
		describeAuditChanges({ value: { before: { footer: '甲' }, after: { footer: '乙' } } }),
		'value.footer：甲 → 乙',
		'只列改动的键',
	);
	// 回读时 JSON 列是文本，写入那一刻是对象，两种都要认。
	assert.equal(
		describeAuditChanges({ value: { before: '{"footer":"甲"}', after: '{"footer":"乙"}' } }),
		'value.footer：甲 → 乙',
	);
	// 嵌套继续往下拆；没变的键一个都不出现。
	assert.equal(
		describeAuditChanges({ value: { before: { a: { b: 1, c: 2 } }, after: { a: { b: 9, c: 2 } } } }),
		'value.a.b：1 → 9',
	);
	// 键名与列名走同一套脱敏规则：base_configs.value 原先因为混着客户端密钥而整列隐藏，
	// 逐键之后只藏密钥那一个，其余照常可见。
	assert.equal(
		describeAuditChanges({ value: { before: { footer: '甲', client_secret: 'x' }, after: { footer: '乙', client_secret: 'y' } } }),
		'value.footer：甲 → 乙\nvalue.client_secret：已变更',
	);
	assert.deepEqual(
		publicAuditChanges({ value: { before: { footer: '甲', client_secret: 'x' }, after: { footer: '乙', client_secret: 'y' } } }),
		{ 'value.footer': { before: '甲', after: '乙' }, 'value.client_secret': { hidden: true } },
	);
	// 数组整体比较：数组的差异是位置和顺序的问题，拆成下标反而更难读。
	assert.equal(describeAuditChanges({ roles: { before: [], after: ['a', 'b'] } }), 'roles：[] → ["a","b"]', '数组按 JSON 显示');

	// ---- 审批（§11）----
	// 默认不勾「立即生效」：记录成待审批，数据一条都不动。
	const pendingContext = context('申请调整角色');
	const beforePending = (await entries()).length;
	const { PendingApprovalError } = await import(pathToFileURL(moduleFile));
	await assert.rejects(
		() => runOperationSql(pendingContext, acting, sql({ database: acting }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })),
		(error) => error instanceof PendingApprovalError,
		'不勾立即生效就该走审批，而不是直接写库',
	);
	let pendingEntry = await latestEntry();
	assert.equal((await entries()).length, beforePending + 1, '待审批也要留记录');
	assert.equal(pendingEntry.review_status, 'pending');
	assert.equal(pendingEntry.data_status, 'unwritten', '待审批的修改从未写入');
	assert.equal(pendingEntry.reason, '申请调整角色');
	const rolesOf = async () => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { roles: 'roles' }, where: [{ column: 'id', value: alice.id }] }))).roles;
	const originalRoles = '[]';
	assert.equal(await rolesOf(), originalRoles, '待审批期间数据一条都不能动');

	// 同一个人对同一条记录再提交一次：覆盖自己那条待审批记录，不再排一条。
	const beforeResubmit = (await entries()).length;
	await assert.rejects(() => runOperationSql(context('改主意了，换成分站管理员'), acting, sql({ database: acting }).update('base_users', { roles: '["branch_admin"]' }, { id: alice.id })));
	assert.equal((await entries()).length, beforeResubmit, '同一个人对同一行重复提交不该堆出多条待审批记录');
	const resubmitted = await entryById(pendingEntry.id);
	assert.equal(resubmitted.reason, '改主意了，换成分站管理员', '待审批记录被覆盖成最新一版');
	assert.deepEqual(JSON.parse(resubmitted.changes).roles, { before: [], after: ['branch_admin'] });
	// 换个人提交同一行：那是另一件事，各排各的队。
	const otherActor = withDatabaseActors(counting, { subjectRoles: ['platform_admin'], humanOperation: true, base: '99' });
	await assert.rejects(() => runOperationSql(context('另一个人的申请'), otherActor, sql({ database: otherActor }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })));
	assert.equal((await entries()).length, beforeResubmit + 1, '不同操作者的申请各排各的队');
	await transitionAuditEntries(acting, [(await latestEntry()).id], 'reject', '清理测试数据');
	// 把这条改回原先的值，后面的断言接得上。
	await assert.rejects(() => runOperationSql(context('申请调整角色'), acting, sql({ database: acting }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })));

	// 先提交待审批、再直写同一行（路由内部的机器写入）：作废的申请被覆盖，不留孤儿记录。
	const beforeSupersede = (await entries()).length;
	await runOperationSql(context('这次直接生效'), acting, sql({ database: acting }).update('base_users', { roles: '["platform_support"]' }, { id: alice.id }), { immediate: true });
	assert.equal((await entries()).length, beforeSupersede, '直写应覆盖自己那条待审批记录，而不是再插一条');
	const superseded = await entryById(pendingEntry.id);
	assert.equal(superseded.review_status, 'none', '直写不是审批');
	assert.equal(superseded.data_status, 'applied');
	assert.equal(superseded.reason, '这次直接生效');
	assert.equal(superseded.reviewed_at, null, '直写不是审批，不该伪造审批时间');
	assert.equal(await rolesOf(), '["platform_support"]');
	// 复位，后面的断言接得上。
	await runOperationSql(context('复位'), acting, sql({ database: acting }).update('base_users', { roles: originalRoles }, { id: alice.id }), { immediate: true });
	await assert.rejects(() => runOperationSql(context('申请调整角色'), acting, sql({ database: acting }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })));
	pendingEntry = await latestEntry();

	// 待审批的记录不能撤回，只能批准或驳回。
	assert.equal((await revert([pendingEntry.id]))[0].message, '当前数据状态是「未写入」，不能执行这个操作');

	// 批准：把 after 写进去，并记下审批人与意见。
	assert.deepEqual(await transitionAuditEntries(acting, [pendingEntry.id], 'approve', '同意'), [{ id: pendingEntry.id, ok: true, message: '已批准' }]);
	assert.equal(await rolesOf(), '["tenant_admin"]', '批准后修改才生效');
	const approved = await entryById(pendingEntry.id);
	assert.equal(approved.review_status, 'approved', '走完队列的才叫已批准');
	assert.equal(approved.data_status, 'applied');
	assert.equal(approved.review_reason, '同意');
	assert.ok(Number(approved.reviewed_at) > 0, '要记下什么时候批的');
	assert.equal(approved.revert_reason, '', '审批与撤回各用一组字段，不能互相覆盖');

	// 批准过的可以再撤回，撤回信息不会覆盖掉「谁批准的」。
	assert.equal((await revert([pendingEntry.id], '批错了'))[0].ok, true);
	const afterRevert = await entryById(pendingEntry.id);
	// 两列正交：回滚只把数据翻回去，「是谁放行的」原样留着。合成一列时这条信息会被冲掉。
	assert.equal(afterRevert.review_status, 'approved', '回滚不该改动审批状态');
	assert.equal(afterRevert.data_status, 'reverted');
	assert.equal(afterRevert.review_reason, '同意', '撤回不能覆盖审批意见');
	assert.equal(afterRevert.revert_reason, '批错了');
	assert.equal(afterRevert.restore_reason, '', '三组字段互不干扰');
	assert.equal(await rolesOf(), originalRoles);

	// 撤销申请自己一组字段：它和审批都从 pending 出发，但一个是审批人的决定、
	// 一个是申请人自己收回，混在一起就分不清那一格记的是谁。
	await assert.rejects(() => runOperationSql(context('申请改名'), acting, sql({ database: acting }).update('base_users', { name: 'withdrawn-name' }, { id: alice.id })));
	const withdrawEntry = await latestEntry();
	assert.deepEqual(await transitionAuditEntries(acting, [withdrawEntry.id], 'withdraw', ''), [{ id: withdrawEntry.id, ok: true, message: '已撤销申请' }]);
	const withdrawn = await entryById(withdrawEntry.id);
	assert.equal(withdrawn.review_status, 'withdrawn');
	assert.equal(withdrawn.data_status, 'unwritten', '撤销的申请从未写入');
	assert.ok(Number(withdrawn.withdrawn_at) > 0, '要记下什么时候撤销的');
	assert.equal(withdrawn.reviewed_at, null, '撤销不是审批，不该占审批那一格');
	assert.equal(withdrawn.reverted_at, null, '撤销更不是回滚：数据从未动过');
	assert.equal(await nameOf(alice.id), 'frank', '撤销不该改动数据');
	// 撤销是终态，和驳回一样不能再迁移。
	assert.equal((await transitionAuditEntries(acting, [withdrawEntry.id], 'approve', ''))[0].ok, false);

	// 驳回：不碰数据，只落状态。
	await assert.rejects(() => runOperationSql(context('申请改名'), acting, sql({ database: acting }).update('base_users', { name: 'rejected-name' }, { id: alice.id })));
	const rejectEntry = await latestEntry();
	assert.deepEqual(await transitionAuditEntries(acting, [rejectEntry.id], 'reject', '不同意'), [{ id: rejectEntry.id, ok: true, message: '已驳回' }]);
	assert.equal(await nameOf(alice.id), 'frank', '驳回不该改动数据');
	assert.equal((await entryById(rejectEntry.id)).review_status, 'rejected');
	// 驳回是终态，不能再迁移。
	assert.equal((await transitionAuditEntries(acting, [rejectEntry.id], 'approve'))[0].message, '当前审批状态是「已驳回」，不能执行这个操作');

	// 非管理员就算发了 X-Change-Immediate 也照样进队列：放行由服务端角色说了算。
	const forged = { req: context('').req, get: (key) => key === 'effectiveRoles' ? ['user'] : undefined, set: () => {} };
	await assert.rejects(
		() => runOperationSql(forged, acting, sql({ database: acting }).update('base_users', { name: 'forged' }, { id: alice.id })),
		(error) => error instanceof PendingApprovalError,
		'非管理员伪造请求头不能跳过审批',
	);
	assert.equal(await nameOf(alice.id), 'frank');
	await transitionAuditEntries(acting, [(await latestEntry()).id], 'reject', '清理测试数据');

	// 列表支持按状态、数据表、记录与原因关键字筛选。
	const { listAuditEntries } = await import(pathToFileURL(moduleFile));
	const pendingOnly = await listAuditEntries(acting, [{ column: 'review_status', value: 'pending' }]);
	assert.ok(pendingOnly.every((entry) => entry.review_status === 'pending'), '按审批状态筛选');
	const selfOnly = await listAuditEntries(acting, [{ column: 'scope', value: 'self' }]);
	assert.ok(selfOnly.every((entry) => entry.scope === 'self'), '按来源筛选');
	const byTable = await listAuditEntries(acting, [{ column: 'table_name', value: 'base_users' }]);
	assert.ok(byTable.length && byTable.every((entry) => entry.table_name === 'base_users'), '按数据表筛选');
	// 匹配的是提交时填的「操作原因」，不含撤回理由与审批意见——那两个各有自己的列。
	const byReason = await listAuditEntries(acting, [], '批量调整');
	assert.ok(byReason.length && byReason.every((entry) => entry.reason.includes('批量调整')), '按原因模糊匹配');
	assert.deepEqual(await listAuditEntries(acting, [], '这段文字不存在'), []);
	// 「全部」用显式哨兵值：空串在 antd 的 Select 里等于「没有选中」，选完会显示成空白。
	const auditRoute = await readFile(resolve(projectDirectory, 'server/routes/base/api/panel/admin/base/audit.mts'), 'utf8');
	assert.match(auditRoute, /ALL_STATUS = 'all'/);
	assert.doesNotMatch(auditRoute, /\{ value: '', text: '全部' \}/);
	await auditRouteFilter();

	// ---- 保留期（§10）----
	const total = (await entries()).length;
	assert.equal(await purgeExpiredAuditEntries(database, 0), 0, '保留期为 0 表示不自动清理');
	assert.equal((await entries()).length, total);
	const oldest = (await entries()).slice(0, 3).map((entry) => entry.id);
	const staleAt = Date.now() - 400 * 86400_000;
	for (const id of oldest) database.prepare('UPDATE base_approvals SET created_at = ? WHERE id = ?').bind(staleAt, id).run();
	assert.equal(await purgeExpiredAuditEntries(database, 365, { batchSize: 2 }), 3, '过期记录应被物理删除，且分批可重入');
	assert.equal((await entries()).length, total - 3, '未到期的记录不受影响');
	assert.equal(await purgeExpiredAuditEntries(database, 365), 0, '再跑一次没有可清理的记录');

	// 保留期按租户独立：读各租户自己的站点设置。
	await runSql(database, sql({ database }).ignoreInsert('base_tenants', ['key'], { key: 'default', title: '默认租户', status: 'enabled' }));
	const remaining = (await entries()).find((entry) => String(entry.owner_tid) === '1');
	database.prepare('UPDATE base_approvals SET created_at = ? WHERE id = ?').bind(staleAt, remaining.id).run();
	assert.equal(await purgeAuditRetention(database), 1, '未配置保留期的租户应回落到默认的 365 天');

	console.log('change audit ok');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
