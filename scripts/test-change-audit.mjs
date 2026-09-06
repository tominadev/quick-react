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
		// row_key 与 settled_at 都要给：`(table_name, row_key, settled_at)` 上有唯一索引，
		// 「一行上同时只能有一条在队列里」是数据库约束。种子里这四条本来就是四个不同的行，
		// 排队中的记 0，已了结的各带一个时间戳。
		for (const [id, review, data] of [['1', 'pending', 'unwritten'], ['2', 'approved', 'applied'], ['3', 'rejected', 'unwritten'], ['4', 'pending', 'unwritten']]) {
			seed.prepare('INSERT INTO base_audits (key, created_at,updated_at,operation_id,reason,table_name,row_id,row_key,action,changes_before,changes_after,review_status,data_status,settled_at) VALUES (lower(hex(randomblob(16))), ?,?,?,?,?,?,?,?,?,?,?,?,?)')
				.run(at, at, id, `理由${id}`, 'base_users', id, `seed-row-${id}`, 'update', '{}', '{}', review, data, review === 'pending' ? 0 : at + Number(id));
		}
		seed.close();
		const headers = {
			'content-type': 'application/json',
			'x-device-key': '00000000000040008000000000000001',
			'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: 'a', audio_cyrb53: 'b' }),
		};
		const login = await app.request('http://localhost/api/sign.php', { method: 'POST', headers, body: JSON.stringify({ user_name: 'auditadmin', password: 'audit-password-1' }) });
		const cookie = login.headers.get('set-cookie')?.split(';')[0];
		const statuses = async (query) => {
			const response = await app.request(`http://localhost/api/panel/admin/base/audit/records.php?include=schema,data${query}`, { headers: { ...headers, cookie } });
			return (await response.json()).table.dataSource.map((row) => row.review_status).sort();
		};
		// 三个筛选都不预设默认值：参数缺失就是「全部」。「待审批」当过默认值，问题是它把
		// 这一页从「变更记录」悄悄变成了「待办列表」——刚提交完想确认记下来没有，翻半天以为没记。
		assert.deepEqual(await statuses(''), ['approved', 'pending', 'pending', 'rejected'], '参数缺失就是全部');
		assert.deepEqual(await statuses('&review_status=pending'), ['pending', 'pending']);
		assert.deepEqual(await statuses('&review_status=approved'), ['approved']);
		// 这就是 /panel/admin/base/audit/records.html?q.review_status=all 实际发出的请求。
		assert.deepEqual(await statuses('&review_status=all'), ['approved', 'pending', 'pending', 'rejected'], 'review_status=all 要返回全部');
		// 数据状态是另一条轴：待审批与被驳回的申请都停在「未写入」。
		assert.deepEqual(await statuses('&review_status=all&data_status=unwritten'), ['pending', 'pending', 'rejected']);

		// 总数要跟着筛选条件走，而且不能拿列表长度充数——列表有 200 条上限，
		// 库里更多时那样会谎报「共 200 条」。
		const totals = async (query) => {
			const response = await app.request(`http://localhost/api/panel/admin/base/audit/records.php?include=schema,data${query}`, { headers: { ...headers, cookie } });
			const body = await response.json();
			return { total: body.table.totalRecords, rows: body.table.dataSource.length };
		};
		assert.deepEqual(await totals('&review_status=all'), { total: 4, rows: 4 });
		assert.deepEqual(await totals('&review_status=approved'), { total: 1, rows: 1 }, '总数要跟着筛选走');
		assert.deepEqual(await totals(''), { total: 4, rows: 4 }, '参数缺失就是全部');
		const overflow = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const now = Date.now();
		for (let index = 0; index < 250; index += 1) {
			// 250 条排队中的记录必须是 250 个不同的行：同一行只放得下一条（唯一索引）。
			overflow.prepare('INSERT INTO base_audits (key, created_at,updated_at,operation_id,reason,table_name,row_id,row_key,action,changes_before,changes_after,review_status,data_status,settled_at) VALUES (lower(hex(randomblob(16))), ?,?,?,?,?,?,?,?,?,?,?,?,0)')
				.run(now, now, `bulk${index}`, '批量', 'base_users', String(index), `bulk-row-${index}`, 'update', '{}', '{}', 'pending', 'unwritten');
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
		// **撤销与驳回互斥**：自己提的叫撤销，别人提的叫驳回，同一批申请不会同时出现两个。
		// 这里两条都是自己提的，因此没有「驳回」；「批准」在场是因为这个账号是超级用户
		// （其余人受四眼原则限制，批不动自己提的，按钮也就不该出现）。
		assert.deepEqual(pendingPage.formPage.notice.actions.map((action) => action.key), ['withdraw-pending', 'approve-pending']);
		assert.equal(pendingPage.currentValues.footer, '页脚甲', '还没批准，页面上仍是旧值');
		assert.equal((await app.request(`${settings}?action=approve-pending`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' })).status, 200);
		const approved = await (await app.request(settings, { headers: { ...headers, cookie } })).json();
		// 批准是直接写回表的，绕过了 configStore 那条会清缓存的路；不清缓存的话这里还是旧值。
		assert.equal(approved.currentValues.footer, '页脚乙', '批准后要立刻生效，不能被配置缓存挡住');
		assert.equal(approved.formPage.notice, undefined);
		// 撤销只收回申请，数据一动不动。
		await put({ footer: '页脚丙', __changedFields: ['footer'] });
		assert.equal((await app.request(`${settings}?action=withdraw-pending`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' })).status, 200);
		const withdrawn = await (await app.request(settings, { headers: { ...headers, cookie } })).json();
		assert.equal(withdrawn.currentValues.footer, '页脚乙', '撤销不改数据');
		assert.equal(withdrawn.formPage.notice, undefined);

		// 四个设置页共用同一个模板，别的页也得有同样的提示和动作：之前只有站点设置接了，
		// 另外三页改了什么在等审批，页面上一点都看不出来。
		const systemSettings = 'http://localhost/api/panel/admin/base/settings/system-config.php';
		const putSystem = (domain) => app.request(systemSettings, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ domain, __changedFields: ['domain'] }) });
		// **第一次保存**也进队列：配置行还不存在，走的是 upsert 的 INSERT 那一支。这里先把
		// 它批掉，下面测的是「已经有行之后再改」那条普通路径。
		assert.equal((await putSystem('unified-jia.example')).status, 202, '第一次保存也要进审批队列');
		assert.equal((await app.request(`${systemSettings}?action=approve-pending`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' })).status, 200);
		assert.equal((await putSystem('unified-yi.example')).status, 202, '系统配置也要进审批队列');
		const systemPage = await (await app.request(systemSettings, { headers: { ...headers, cookie } })).json();
		assert.match(systemPage.formPage.notice.title, /有 1 项修改正在等待审批/, '系统配置页也要显示待审批提示');
		assert.match(systemPage.formPage.notice.lines.join('\n'), /unified-jia\.example → unified-yi\.example/);
		assert.deepEqual(systemPage.formPage.notice.actions.map((action) => action.key), ['withdraw-pending', 'approve-pending'], '自己提的只给撤销，不给驳回');
		assert.equal((await app.request(`${systemSettings}?action=approve-pending`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' })).status, 200);
		const systemApproved = await (await app.request(systemSettings, { headers: { ...headers, cookie } })).json();
		assert.equal(systemApproved.currentValues.domain, 'unified-yi.example', '批准后系统配置也要立刻生效');
		assert.equal(systemApproved.formPage.notice, undefined);

		// TableCRUD 一律通用：有修改在等审批的行会被标出来，并挂上撤销与批准。
		// 先清掉上面为测总数塞的假记录：它们的 table_name 也是 base_users、row_id 是 0..249，
		// 会和新建账号的 id 撞上，让这一段测到的是那些假记录。
		const cleanup = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		cleanup.prepare("DELETE FROM base_audits WHERE changes_after = '{}'").run();
		cleanup.close();
		const usersApi = 'http://localhost/api/panel/admin/base/users.php';
		// 建号也进审批队列（§13.6），三行共享一个操作号；先批掉，后面验的是「改」不是「建」。
		await app.request(usersApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'pendingbob', password: 'bob-password-123', roles: [], status: 'enabled' }) });
		{
			const queued = await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json();
			const ids = queued.table.dataSource.map((row) => String(row.id));
			// 只批一条：同一个操作号的其余记录会跟着一起生效——只批账号那一行，
			// 得到的是「能登录但没有密码」。
			assert.equal((await app.request('http://localhost/api/panel/admin/base/audit/records.php?action=approve', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify(ids.slice(0, 1)) })).status, 200);
			const left = await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json();
			assert.equal(left.table.dataSource.length, 0, '同一次操作的记录要一起批准');
		}
		const listBefore = await (await app.request(`${usersApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
		const bob = listBefore.table.dataSource.find((row) => row.user_name === 'pendingbob');
		assert.ok(bob, '新建的账号应该在列表里');
		assert.equal((await app.request(`${usersApi}/${bob.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ status: 'disabled', __changedFields: ['status'] }) })).status, 202);
		const marked = await (await app.request(`${usersApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
		assert.equal(marked.table.columns.some((column) => column.dataIndex === '_pending'), false, '不开「审批」列：标记是数据不是列，前端拿它给那一行换底色');
		assert.equal(marked.table.dataSource.find((row) => row.user_name === 'pendingbob')._pending, 'update-mine');
		// 传输层说真话：没值就是 null，不折成空串。「没填」怎么读由列上的 emptyText 声明，
		// 而受控输入吃不下 null 那件事在表单那一层解决（drawer 按控件类型归一），不是靠每个
		// 路由各写一遍 `?? ''`——那等于在传输层把「有没有值」这个信息抹掉，下游再也拿不回来。
		{
			const listed = await (await app.request('http://localhost/api/panel/admin/base/users.php?include=schema,data', { headers: { ...headers, cookie } })).json();
			const contact = listed.table.columns.find((column) => column.dataIndex === 'profile_wechat');
			assert.equal(contact.emptyText, '未填写', '列自己声明没值时读作什么');
			assert.equal(listed.table.dataSource[0].profile_wechat, null, '没填就发 null，不发空串');
		}

		/**
		 * 数据管理的表单限制**一律照抄表结构**，不自己加也不自己减。
		 *
		 * - 可空看 `notnull`：可空的列才给那个能表达 NULL 的控件。不额外标必填——`NOT NULL`
		 *   说的是「不能是 NULL」，不是「不能是空串」，标了就是替表加一条它没有的限制。
		 * - 数值型给数字输入框，但 **BIGINT 除外**：雪花号 19 位，超过 JS 能精确表示的整数，
		 *   进数字框会被悄悄改成另一个数。
		 * - 长度取自 `VARCHAR(n)`；SQLite 上 prisma 把 `@db.VarChar` 落成 `TEXT`，表本身没有
		 *   长度限制，界面因此也不给——表没规定，界面不该替它规定。
		 */
		const schemaDriven = await (await app.request('http://localhost/api/panel/admin/base/data/rows.php?table=base_users&include=schema,data', { headers: { ...headers, cookie } })).json();
		const byName = Object.fromEntries(schemaDriven.table.columns.map((column) => [column.dataIndex, column]));
		assert.equal(byName.agent_uid.nullable, true, 'BigInt? → 可空');
		assert.equal(byName.name.nullable, undefined, 'String → 不可空');
		assert.equal(byName.name.rules, undefined, '不可空不等于必填');
		assert.equal(byName.agent_uid.component, 'textbox', 'BIGINT 不给数字框：雪花号进去会被精度改掉');
		const flags = await (await app.request('http://localhost/api/panel/admin/base/data/rows.php?table=passport_oidc_clients&include=schema,data', { headers: { ...headers, cookie } })).json();
		// 控件照搬表结构：BOOLEAN 给开关。（数字框那一支由 numericComponent 覆盖，
		// 这张表改成 Boolean 之后已经没有普通 Int 列可验了。）
		assert.equal(flags.table.columns.find((column) => column.dataIndex === 'require_pkce').component, 'switch', 'BOOLEAN 给开关');

		/**
		 * 完整经过要点得到：列表上只有「最近审批」一行，而一条记录可能被驳回、恢复、批准、
		 * 回滚、重新应用地翻好几轮。行上挂一个「审批记录」弹窗，带上 audit_id——不带的话
		 * 弹开的是全站事件。
		 */
		const auditTable = await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=schema,data&review_status=all', { headers: { ...headers, cookie } })).json();
		const approvalsAction = auditTable.table.option.actions.row.find((action) => action.key === 'approvals');
		assert.equal(approvalsAction?.label, '审批记录');
		assert.equal(approvalsAction.modalComponent, 'table');
		assert.deepEqual(approvalsAction.modalQueryFields, { audit_id: 'id' }, '带上本行的 id，否则弹开的是全站事件');
		/**
		 * **两条以上才给按钮。** 一条的时候列表上那一列「最近审批」显示的就是它的全部
		 * （时间、审批动作、操作者、理由），点开只是把同一行字换个地方再看一遍。
		 */
		assert.deepEqual(approvalsAction.visibleWhen, { field: '_approvals', values: ['many'] });
		const approvalCounts = new Set(auditTable.table.dataSource.map((row) => row._approvals));
		assert.ok(approvalCounts.has('one') || approvalCounts.has(''), '只处理过一次或没处理过的行不给按钮');
		const approvalsPage = await (await app.request('http://localhost/api/panel/admin/base/audit/approvals.php?include=schema,data', { headers: { ...headers, cookie } })).json();
		// 只读：事件只追加不修改，改一条已经发生的审批记录等于篡改证据。
		assert.deepEqual(Object.keys(approvalsPage.table.option.actions), ['query'], '没有新增、编辑、删除，也没有回收站');
		assert.deepEqual(approvalsPage.table.columns.map((column) => column.dataIndex), ['id', 'created_at', 'created_duid', 'audit_id', 'kind', 'reason']);
		/**
		 * **一个 kind 只有一个中文名。** 原先记录里另有一套说法（`管理批准`、`执行回滚`），
		 * 于是同一个 redo 在按钮上叫「重新应用」、在记录里叫「执行重做」——两个词指同一件事。
		 * 现在中文取自 APPROVAL_KINDS 的动作名，谁做的由旁边的操作者列回答。
		 */
		assert.deepEqual(
			approvalsPage.table.columns.find((column) => column.dataIndex === 'kind').options.map((option) => option.text),
			['撤销(withdraw)', '批准(approve)', '驳回(reject)', '恢复(requeue)', '回滚(revert)', '重新应用(redo)'],
		);

		// 四种申请各挂一组按钮，由 visibleWhen 按行显隐：撤销只对自己提的出现，
		// 驳回只对别人提的出现，批准自己那一份只给超级用户。
		const markedActions = marked.table.option.actions.row.filter((action) => action.visibleWhen?.field === '_pending');
		assert.ok(markedActions.some((action) => action.label === '撤销修改' && action.visibleWhen.values.includes('update-mine')));
		assert.ok(markedActions.some((action) => action.label === '批准新增'));
		assert.ok(markedActions.some((action) => action.label === '驳回删除' && action.visibleWhen.values.includes('soft_delete-other')));
		assert.equal(marked.table.dataSource.find((row) => row.user_name === 'pendingbob').status, 'enabled', '还没批准就不该生效');
		assert.equal((await app.request(`${usersApi}/${bob.id}?action=approve-pending`, { method: 'POST', headers: { ...headers, cookie }, body: '{}' })).status, 200);
		const applied = await (await app.request(`${usersApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
		assert.equal(applied.table.dataSource.find((row) => row.user_name === 'pendingbob').status, 'disabled');
		assert.equal(applied.table.dataSource.find((row) => row.user_name === 'pendingbob')._pending, '', '批完标记要清掉');

		// ---- 新建也进审批队列 ----
		// 行照写进库，但 queued_at 非零让它对所有正常查询不可见；批准把它归零，
		// 驳回把那一行物理删掉——它从未生效过，历史留在这条审批记录上。
		const rowsApi = 'http://localhost/api/panel/admin/base/data/rows.php?table=base_configs';
		// 数据管理**不过滤 queued_at**：它看的是表里实际有什么。所以「生效的行」在这里要
		// 自己按 queued_at 收一次——顺带证明待审批的那一行确实躺在库里，只是还没生效。
		const configRows = async () => (await (await app.request(`${rowsApi}&include=data`, { headers: { ...headers, cookie } })).json()).table.dataSource;
		// 配置项名在 name 上，key 是机器写的雪花号——只用来指向这一行，不承载业务含义。
		const visibleKeys = async () => (await configRows()).filter((row) => String(row.queued_at) === '0').map((row) => row.name);
		const queuedKeys = async () => (await configRows()).filter((row) => String(row.queued_at) !== '0').map((row) => row.name);
		const pendingIds = async () => (await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json())
			.table.dataSource.map((row) => String(row.id));
		const decide = (action, ids) => app.request(`http://localhost/api/panel/admin/base/audit/records.php?action=${action}`, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify(ids) });

		assert.equal((await app.request(rowsApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ name: 'audit_fixture', value: '{}' }) })).status, 202, '新建也要进审批队列');
		assert.equal((await visibleKeys()).includes('audit_fixture'), false, '没批准之前这一行不该生效');
		assert.equal((await queuedKeys()).includes('audit_fixture'), true, '但它躺在库里，数据管理看得见');
		const insertEntry = (await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json())
			.table.dataSource.find((row) => row.summary.includes('audit_fixture'));
		assert.equal(insertEntry.action, 'insert');
		assert.equal(insertEntry.data_status, 'unwritten');
		// 新建记录里写下将要新增的内容：待审批的行带着 queued_at，在任何正常列表里都看不见，
		// 让审批人「自己去看那一行」是行不通的。
		// `key` 不重复进来——它已经是这条记录的「记录标识」那一列，而且现在是机器写的雪花号，
		// 抄进变更内容里对审批人没有任何意义。人取的那一份在 name 上，照常进来。
		assert.match(insertEntry.summary, /value：空 → \{\}/, '审批人要看得见自己在批什么');
		assert.match(insertEntry.summary, /name：空 → audit_fixture/, '人取的名字要看得见');
		assert.match(String(insertEntry.row_key), /^\d+$/, '记录标识是那一行的 key，机器写的雪花号');
		assert.equal((await decide('approve', [String(insertEntry.id)])).status, 200);
		assert.equal((await visibleKeys()).includes('audit_fixture'), true, '批准之后这一行才开始存在');

		// 撞唯一索引不该在队列里留下孤儿。
		//
		// 新建是「行照写、queued_at 非零」，所以唯一索引在**提交那一刻**就会拦下来；而审批
		// 记录是先写的。不清理的话，队列里会留下一条指向从未写成的行的申请——批也批不动，
		// 界面上却像是有人在等审批。顺带：撞唯一索引是 409，不是 500。
		const queuedBefore = (await pendingIds()).length;
		// 撞的是 name 上那条唯一索引：key 现在是机器写的雪花号，人再怎么提交也撞不上它。
		const duplicate = await app.request(rowsApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ name: 'audit_fixture', value: '{}' }) });
		assert.equal(duplicate.status, 409, '重复的名字是用户输入的正常结果，不是服务端故障');
		assert.equal((await pendingIds()).length, queuedBefore, '失败的新建不该在队列里留下申请');

		// 驳回：那一行进回收站，不是凭空消失。
		//
		// 软删除本来就有保留期，被驳回的新建因此看得见、找得回——审批人手一抖驳回了别人
		// 半天的录入，那份录入不该就此不存在。queued_at 一并归零，让它成为一条普通的
		// 已删除记录：留着非零的话，从回收站恢复出来的行仍然对业务查询不可见，却又出现在
		// 管理列表里，成了一个谁也说不清状态的幽灵。
		assert.equal((await app.request(rowsApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ name: 'audit_rejected', value: '{}' }) })).status, 202);
		assert.equal((await decide('reject', await pendingIds())).status, 200);
		assert.equal([...await visibleKeys(), ...await queuedKeys()].includes('audit_rejected'), false, '驳回之后不该还在生效的行里');
		const leftovers = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const rejectedRow = leftovers.prepare("SELECT deleted_at, queued_at FROM base_configs WHERE name = 'audit_rejected'").get();
		assert.ok(rejectedRow, '被驳回的新建留在回收站里，不是物理删掉');
		assert.notEqual(Number(rejectedRow.deleted_at), 0, '进了回收站');
		assert.equal(Number(rejectedRow.queued_at), 0, '并且是一条普通的已删除记录');
		leftovers.close();

		// 点批准/撤销/驳回时，动的是**页面上看到的那几条**申请。
		//
		// 只按行号解的话，服务端会在收到请求时重新问一遍「这一行有哪些待审批」——中间别人
		// 又提了一条，点下去就连它一起处理了，而那一条操作者根本没看见。列表把待审批记录的
		// id 跟着行一起发下去，动作声明 sendFields 把它原样带回来；对不上就要求刷新，
		// 而不是照着服务端当下解出来的那一份执行。
		const staleApi = 'http://localhost/api/panel/admin/base/users.php';
		const staleId = (await (await app.request(`${staleApi}?include=data`, { headers: { ...headers, cookie } })).json())
			.table.dataSource.find((row) => row.user_name === 'pendingbob').id;
		assert.equal((await app.request(`${staleApi}/${staleId}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'pendingbob3', __changedFields: ['user_name'] }) })).status, 202);
		const staleTable = await (await app.request(`${staleApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
		const staleRow = staleTable.table.dataSource.find((row) => String(row.id) === String(staleId));
		assert.deepEqual(staleTable.table.option.actions.row.find((action) => action.label === '批准修改')?.sendFields, ['_pending_ids'], '动作要声明把哪几个字段带回去');
		assert.ok(staleRow._pending_ids, '行上要带着待审批记录的 id');
		const bogus = await app.request(`${staleApi}/${staleId}?action=approve-pending`, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ _pending_ids: `${staleRow._pending_ids},999999` }) });
		assert.equal(bogus.status, 409, '带回来的 id 与这一行当下的待审批对不上就不执行');
		assert.match((await bogus.json()).feedback?.message ?? '', /已经变了，请刷新/);
		assert.equal((await app.request(`${staleApi}/${staleId}?action=approve-pending`, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ _pending_ids: staleRow._pending_ids }) })).status, 200, '对得上就照常批准');

		// **存在性还没定下来之前，不接受别的申请。**
		//
		// 新增、删除、恢复决定的是「这一行在不在」，修改决定的是「它是什么样」。一行同时
		// 挂着两类申请时，审批人得在脑子里合并几条记录才知道批准之后是什么样，而「驳回新增 +
		// 批准修改」这类组合根本没人想要——那条修改作用在一行已经进了回收站的记录上。
		const mixApi = 'http://localhost/api/panel/admin/base/users.php';
		const mixList = async () => (await (await app.request(`${mixApi}?include=schema,data`, { headers: { ...headers, cookie } })).json()).table;
		// 上一段把它改名成了 pendingbob3。
		const mixTarget = (await mixList()).dataSource.find((row) => String(row.id) === String(staleId));
		const mixQueue = async () => (await (await app.request(`http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending&table_name=base_users&row_id=${mixTarget.id}`, { headers: { ...headers, cookie } })).json())
			.table.dataSource.map((row) => row.action).sort();
		assert.equal((await app.request(mixApi, { method: 'DELETE', headers: { ...headers, cookie }, body: JSON.stringify([String(mixTarget.id)]) })).status, 202);
		assert.deepEqual(await mixQueue(), ['soft_delete']);
		// 界面上先收起按钮：这一行只剩撤销/批准。
		const lockedTable = await mixList();
		const lockedRow = lockedTable.dataSource.find((row) => String(row.id) === String(staleId));
		assert.equal(lockedRow._pending, 'soft_delete-mine');
		const lockedLabels = lockedTable.option.actions.row.filter((action) => !action.visibleWhen || action.visibleWhen.values.includes(lockedRow._pending)).map((action) => action.label);
		assert.deepEqual(lockedLabels, ['撤销删除', '批准删除'], '待删除的行不给编辑和删除按钮');
		// 服务端再挡一次：按钮不出现只是不引诱人去点。
		const locked = await app.request(`${mixApi}/${mixTarget.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ status: 'enabled', __changedFields: ['status'] }) });
		assert.equal(locked.status, 409, '待删除的行不接受修改申请');
		assert.match((await locked.json()).feedback?.message ?? '', /「删除」申请正在等待审批/);
		// 同一个动作重新提交仍然照旧覆盖——那是「重说一遍」，不是叠加。
		assert.equal((await app.request(mixApi, { method: 'DELETE', headers: { ...headers, cookie }, body: JSON.stringify([String(mixTarget.id)]) })).status, 202);
		assert.deepEqual(await mixQueue(), ['soft_delete'], '还是一条');
		// 反过来也一样：挂着修改申请时不给删除按钮，也不接受删除申请——
		// 一行同时挂着「修改」和「删除」的话，`?action=withdraw-pending` 这个请求本身说不清
		// 撤的是哪一件，而界面只显示得出一对按钮，点「撤销删除」会把那条修改一起撤了。
		assert.equal((await app.request(`${mixApi}/${mixTarget.id}?action=withdraw-pending`, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ _pending_ids: lockedRow._pending_ids }) })).status, 200);
		assert.equal((await app.request(`${mixApi}/${mixTarget.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ status: 'enabled', __changedFields: ['status'] }) })).status, 202);
		const editingTable = await mixList();
		const editingRow = editingTable.dataSource.find((row) => String(row.id) === String(mixTarget.id));
		assert.equal(editingRow._pending, 'update-mine');
		assert.deepEqual(
			editingTable.option.actions.row.filter((action) => !action.visibleWhen || action.visibleWhen.values.includes(editingRow._pending)).map((action) => action.label),
			['编辑', '撤销修改', '批准修改'],
			'编辑留着（重新提交等于重说一遍，覆盖上一条），删除收起来',
		);
		const blockedDelete = await app.request(mixApi, { method: 'DELETE', headers: { ...headers, cookie }, body: JSON.stringify([String(mixTarget.id)]) });
		assert.equal(blockedDelete.status, 409);
		assert.match((await blockedDelete.json()).feedback?.message ?? '', /「修改」申请正在等待审批/);
		assert.equal((await decide('withdraw', await pendingIds())).status, 200);

		/**
		 * **后台第一次写一张表的某一行，同样进队列。**
		 *
		 * 那条语句是 upsert：行不存在时走 INSERT。审计那一层是按修改的形状记的——读不到
		 * 前值就当作「什么都没改」，于是原先语句被直接执行掉：**每一项配置、每个账号的
		 * 第一份资料，第一次保存既不进队列也不留痕，从第二次起才正常。**
		 */
		const firstSaveApi = 'http://localhost/api/panel/admin/base/users.php';
		const firstSaveTarget = (await (await app.request(`${firstSaveApi}?include=data`, { headers: { ...headers, cookie } })).json())
			.table.dataSource.find((row) => row.user_name === 'pendingbob3');
		assert.equal((await app.request(`${firstSaveApi}/${firstSaveTarget.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ profile_qq: '10001', __changedFields: ['profile_qq'] }) })).status, 202, '第一次给这个账号写资料也要进队列');
		const firstSaveEntry = (await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending&table_name=base_user_profiles', { headers: { ...headers, cookie } })).json())
			.table.dataSource.find((row) => row.action === 'insert');
		assert.ok(firstSaveEntry, '记成一条新增');
		assert.match(firstSaveEntry.summary, /qq：空 → 10001/, '审批人看得见要写进去的是什么');
		assert.equal((await decide('withdraw', await pendingIds())).status, 200);

		// 个人中心第一次设资料（资料行还不存在）也要留痕，只是立即生效。
		//
		// 那条语句是 upsert：冲突走 UPDATE、不冲突走 INSERT，建语句时不知道是哪一支。
		// 原先一律按修改记，于是走 INSERT 那一支时读不到前值，一条记录都没有——
		// 做完在审批表里找不到「谁第一次设了昵称」。
		const meApi = 'http://localhost/api/panel/user/base/me.php';
		assert.equal((await app.request(meApi, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ _section: 'profile', profile_nickname: '首次设置的昵称', profile_qq: '', profile_wechat: '', profile_email: '', __changedFields: ['profile_nickname'] }) })).status, 200, '个人中心立即生效');
		const selfEntries = await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&scope=self&table_name=base_user_profiles', { headers: { ...headers, cookie } })).json();
		const created = selfEntries.table.dataSource.find((row) => row.action === 'insert');
		assert.ok(created, '第一次设资料要留下一条「新增」');
		assert.match(created.summary, /nickname：空 → 首次设置的昵称/, '记下新增的内容');
		assert.equal(created.review_status, 'none', '没有审批人可言');
		assert.equal(created.data_status, 'applied', '已经生效');

		// 一次操作里的几行有先后：建起来从账号开始，拆掉反着来（先资料后账号）——
		// 中间那一刻不能出现「凭证指向一个已经不存在的账号」。
		assert.equal((await app.request(usersApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'rejectme', password: 'reject-password-1', roles: [], status: 'enabled', profile_nickname: '要被驳回' }) })).status, 202);
		// 管理后台的列表**看得见**待审批的新行，并且带上「待审批」标记和撤销/批准两个动作——
		// 看不见的话，提交的人以为没保存成功，审批的人也没地方点。
		const pendingList = await (await app.request(`${usersApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
		const queuedRow = pendingList.table.dataSource.find((row) => row.user_name === 'rejectme');
		assert.ok(queuedRow, '待审批的新账号要出现在用户管理里');
		assert.equal(queuedRow._pending, 'insert-mine', '标成「我提的新增」——按钮据此显示成「撤销新增」而不是笼统的「撤销」');
		// 不为它开一列：`_pending` 是数据不是列，前端拿它给那几行换底色。
		assert.equal(pendingList.table.columns.some((column) => column.dataIndex === '_pending'), false, '不该多出一列');
		const rowActions = pendingList.table.option.actions.row.map((action) => action.key);
		assert.ok(rowActions.includes('withdraw-pending') && rowActions.includes('approve-pending'), '行上要有撤销和批准');
		// 写操作之后前端只取 data，用缓存的表结构。那次响应照样要带上 _pending，
		// 否则删一行之后得整页刷新才看得见「撤销」。
		const dataOnly = await (await app.request(`${usersApi}?include=data`, { headers: { ...headers, cookie } })).json();
		assert.equal('option' in dataOnly.table, false, '只请求数据时不该下发结构');
		assert.equal(dataOnly.table.dataSource.find((row) => row.user_name === 'rejectme')?._pending, 'insert-mine', '只取数据也要带标记');

		// 待审批的新行同样锁着：改它、删它都不接受，界面上也只剩回滚/批准。
		//
		// 不锁的话那条 insert 会被随后的 update 覆盖，批准时就没有人再去把 queued_at 归零
		// ——行永远隐身、账号登不进去，而审批列表显示一切正常。这条路是「管理列表看得见
		// 待审批的新行」之后才走得到的：看不见就点不到编辑。
		const draft = pendingList.table.dataSource.find((row) => row.user_name === 'rejectme');
		const draftLabels = pendingList.table.option.actions.row.filter((action) => !action.visibleWhen || action.visibleWhen.values.includes(draft._pending)).map((action) => action.label);
		assert.deepEqual(draftLabels, ['编辑', '撤销新增', '批准新增'], '草稿可以改，但不给删除按钮——删它是另一种动作');
		/**
		 * **改一份还没生效的新建，直接写进去，不另开申请。**
		 *
		 * 那一行带着 queued_at，谁也看不见，改它没有任何对外后果。再排一次队只会让审批人
		 * 面对两条记录，还得自己合并出「批准之后是什么样」；合进去之后队列里始终一条，
		 * 写的就是最终内容。
		 */
		const draftEdit = await app.request(`${usersApi}/${draft.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ status: 'disabled', __changedFields: ['status'] }) });
		assert.equal(draftEdit.status, 200, '改草稿立即生效，不进队列');
		const draftEntries = (await (await app.request(`http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending&table_name=base_users&row_id=${draft.id}`, { headers: { ...headers, cookie } })).json()).table.dataSource;
		assert.deepEqual(draftEntries.map((row) => row.action), ['insert'], '还是一条新建，没多出一条修改');
		assert.match(draftEntries[0].summary, /status：空 → disabled/, '新建记录里的内容跟着刷新');
		// 再改回去，同样立即生效——后面的用例还要用这个账号登录。
		assert.equal((await app.request(`${usersApi}/${draft.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ status: 'enabled', __changedFields: ['status'] }) })).status, 200);
		// 但换一种动作仍然挡住：删它不是改草稿。
		assert.equal((await app.request(usersApi, { method: 'DELETE', headers: { ...headers, cookie }, body: JSON.stringify([String(draft.id)]) })).status, 409, '删它是另一种动作，仍然挡住');
		const queuedInsert = await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json();
		const queuedInserts = queuedInsert.table.dataSource.filter((row) => row.action === 'insert');
		assert.equal(queuedInserts.length, 3, '建号写三行：账号、凭证、资料');
		assert.equal(new Set(queuedInserts.map((row) => row.operation_id)).size, 1, '三条共享一个操作号');
		assert.equal((await app.request('http://localhost/api/panel/admin/base/audit/records.php?action=reject', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify([String(queuedInserts[0].id)]) })).status, 200);
		const afterReject = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		// 三行一起进回收站，一行都不能落下——落下的那一行会指向一个已经不在生效列表里的账号。
		const rejectedUser = afterReject.prepare("SELECT id, deleted_at, queued_at FROM base_users WHERE name = 'rejectme'").get();
		assert.ok(rejectedUser, '驳回是软删除，账号那一行留在回收站里');
		assert.notEqual(Number(rejectedUser.deleted_at), 0, '账号进了回收站');
		assert.equal(Number(rejectedUser.queued_at), 0, '并且是一条普通的已删除记录');
		const live = 'SELECT id FROM base_users WHERE deleted_at = 0 AND queued_at = 0';
		assert.equal(afterReject.prepare(`SELECT COUNT(*) AS n FROM base_user_credentials WHERE deleted_at = 0 AND user_id NOT IN (${live})`).get().n, 0, '驳回不能留下指向已删除账号的凭证');
		assert.equal(afterReject.prepare(`SELECT COUNT(*) AS n FROM base_user_profiles WHERE deleted_at = 0 AND user_id NOT IN (${live})`).get().n, 0, '资料同理');
		afterReject.close();

		/**
		 * 凭证也进 changes_after，因此**换掉待审批那一行的密码也会被发现**。
		 *
		 * 它存的本来就是摘要，抄进记录里抄的也是摘要，不是口令。顺带审批人看得到**密码规律**
		 * ——「这个新账号的密码是 8 位纯数字」是一条能据此驳回的理由，而规律既不是口令、
		 * 也推不出口令，就是用户管理页上那一列「密码特征」。
		 */
		{
			const pwdApi = 'http://localhost/api/panel/admin/base/users.php';
			assert.equal((await app.request(pwdApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'pwdguy', password: 'Abc12345', roles: [], status: 'enabled' }) })).status, 202);
			const queued = await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending&table_name=base_user_credentials', { headers: { ...headers, cookie } })).json();
			const credential = queued.table.dataSource[0];
			assert.match(credential.summary, /password（规律）：空 → ULLDDDDD/, '看得到规律，看不到口令');
			assert.doesNotMatch(credential.summary, /salt|hash|Abc12345/, '整块 blob 一个字都不露');
			// 把待审批那一行的凭证换掉，批准就该被挡住。
			const swap = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
			swap.prepare("UPDATE base_user_credentials SET password = json('{\"salt\":\"x\",\"hash\":\"y\",\"pattern\":\"DDDD\"}') WHERE user_id = (SELECT id FROM base_users WHERE name = 'pwdguy')").run();
			swap.close();
			const decided = await decide('approve', await pendingIds());
			assert.match((await decided.json()).feedback?.message ?? '', /内容与申请里的不一致/);
			assert.equal((await decide('reject', await pendingIds())).status, 200);
		}

		/**
		 * **批准之前核一遍内容：你批的必须就是你看到的。**
		 *
		 * 批准修改早就有这道校验（每一列的当前值必须还等于记录里的前值），批准新增却没有：
		 * `activate()` 只把 queued_at 归零，不看内容。于是待审批期间那一行被别处改过的话，
		 * 审批人看着「newguy / 普通用户」点了批准，生效的却是别的东西，而记录上仍然写着
		 * 他看过的那一份。
		 */
		{
			const contentApi = 'http://localhost/api/panel/admin/base/users.php';
			assert.equal((await app.request(contentApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'tampered', password: 'tamper-password-1', roles: [], status: 'enabled' }) })).status, 202);
			const queued = (await pendingIds());
			const tamper = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
			tamper.prepare("UPDATE base_users SET name='hijacked' WHERE name='tampered'").run();
			tamper.close();
			const decided = await decide('approve', queued);
			assert.equal(decided.status, 200);
			assert.match((await decided.json()).feedback?.message ?? '', /内容与申请里的不一致/);
			const checked = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
			assert.notEqual(Number(checked.prepare("SELECT queued_at FROM base_users WHERE name='hijacked'").get().queued_at), 0, '核不上就不生效');
			checked.close();
			assert.equal((await decide('reject', await pendingIds())).status, 200);
		}

		/**
		 * **回滚与重新应用也核内容——这一行还要继续存在的每一次翻面都核。**
		 *
		 * 原先只核了批准。可回滚过的行躺在回收站里照样收得下修改申请，改一笔再点「重新应用」，
		 * 记录上写着 enabled、捞回主表的却是 disabled；回滚同理，看着 A 下线的却是 B，
		 * 别人对这一行的合法修改就这么被一起埋了。
		 *
		 * 驳回与撤销**不**核，那是有意留的退路：它们把这一行彻底作废，这里也跟着核的话，
		 * 一条内容被动过手脚的待审批新增就成了死结——批不了，也否不掉。
		 */
		{
			const flipApi = 'http://localhost/api/panel/admin/base/users.php';
			assert.equal((await app.request(flipApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'flipguy', password: 'flip-password-1', roles: [], status: 'enabled' }) })).status, 202);
			const insertIds = await pendingIds();
			assert.equal((await decide('approve', insertIds)).status, 200);
			const entryId = insertIds[insertIds.length - 1];
			const flip = async (action) => {
				const response = await decide(action, [entryId]);
				return (await response.json()).feedback?.message ?? '';
			};
			// 内容没动过，回滚照常。
			assert.match(await flip('revert'), /已回滚/);
			// 趁它在回收站里把内容换掉，重新应用就该被挡住。
			const tamper = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
			tamper.prepare("UPDATE base_users SET status='disabled' WHERE name='flipguy'").run();
			assert.match(await flip('redo'), /内容与申请里的不一致.*无法重新应用/);
			assert.equal(Number(tamper.prepare("SELECT deleted_at FROM base_users WHERE name='flipguy'").get().deleted_at) === 0, false, '核不上就不捞回主表');
			// 换回来就捞得回来。这里只看库里的结果，不看那句话：一次迁移作用在**整个操作号**上
			// （建一个账号同时写了 base_users 和 base_user_credentials 两条记录），上一步核不上的
			// 只有带 status 的那一条，另一条已经先应用了，于是这一次的回执是「成功 1 条，失败 1 条」。
			tamper.prepare("UPDATE base_users SET status='enabled' WHERE name='flipguy'").run();
			await flip('redo');
			assert.equal(Number(tamper.prepare("SELECT deleted_at FROM base_users WHERE name='flipguy'").get().deleted_at), 0, '核得上就捞回主表');
			// 再改一次，连回滚也挡住——两个方向用同一把尺子。
			tamper.prepare("UPDATE base_users SET status='disabled' WHERE name='flipguy'").run();
			assert.match(await flip('revert'), /内容与申请里的不一致.*无法回滚/);
			assert.equal(Number(tamper.prepare("SELECT deleted_at FROM base_users WHERE name='flipguy'").get().deleted_at), 0, '核不上就不下线');
			tamper.close();
		}

		/**
		 * **点 ✕ 清成「未填写」要一路存成 NULL,别在收参数那一层被折成空串。**
		 *
		 * 后台改资料与个人中心走的是同一个 `profileStatement`,但各有各的收参数那一行,
		 * 原先两处都写着 `String(body[name] ?? '')`——控件辛苦分出来的两种状态,在最靠近人的
		 * 地方又被压回一种。这里守后台那一路。
		 */
		{
			const nullApi = 'http://localhost/api/panel/admin/base/users.php';
			assert.equal((await app.request(nullApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'nullguy', password: 'null-password-1', roles: [], status: 'enabled', profile_qq: '999', profile_wechat: 'wx9' }) })).status, 202);
			assert.equal((await decide('approve', await pendingIds())).status, 200);
			const columns = () => {
				const check = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
				const row = check.prepare("SELECT qq, wechat FROM base_user_profiles WHERE user_id = (SELECT id FROM base_users WHERE name = 'nullguy')").get();
				check.close();
				// node:sqlite 返回的是 null-prototype 对象，展开一层才比得了。
				return { ...row };
			};
			assert.deepEqual(columns(), { qq: '999', wechat: 'wx9' }, '先都填上');
			const target = (await (await app.request(`${nullApi}?include=schema,data`, { headers: { ...headers, cookie } })).json()).table.dataSource.find((row) => row.user_name === 'nullguy');
			assert.equal((await app.request(`${nullApi}/${target.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ profile_qq: null, __changedFields: ['profile_qq'] }) })).status, 202);
			assert.equal((await decide('approve', await pendingIds())).status, 200);
			assert.deepEqual(columns(), { qq: null, wechat: 'wx9' }, '点 ✕ 存 NULL，且只动这一列');
		}

		/**
		 * **别人提交的申请把这一行整个锁住：什么动作都不给做。**
		 *
		 * 比 §13.6 那条「只允许一种动作」更狠一层。那条挡的是「叠加」，同一个动作的重新提交
		 * 照旧放行（重说一遍，覆盖上一条）——可换成别人来重说就完全变味了：他覆盖掉的是另一个
		 * 人写的内容，而记录上的提交人还是原来那位，审批人看到的申请署着甲的名、写着乙的字。
		 *
		 * 这一段必须走 HTTP：人际锁比到**人**，而模块级的 runOperationSql 用的假上下文里
		 * 没有 currentUser，认不出「我是谁」就不判这一层（见 findConflictingPending）。
		 */
		{
			const lockApi = 'http://localhost/api/panel/admin/base/users.php';
			// 乙：有审批权的第二个管理员，与甲是两个不同的人。
			assert.equal((await app.request(lockApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'locker', password: 'lock-password-1', roles: ['platform_admin'], status: 'enabled', profile_nickname: '乙管理员' }) })).status, 202);
			assert.equal((await decide('approve', await pendingIds())).status, 200);
			assert.equal((await app.request(lockApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'locked', password: 'lock-password-2', roles: [], status: 'enabled' }) })).status, 202);
			assert.equal((await decide('approve', await pendingIds())).status, 200);
			// 乙用另一台设备登录：人际锁比到人，两个人就得是两台设备两份会话。
			const otherHeaders = { ...headers, 'x-device-key': '000000000000400080000000000000b0', 'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: 'c', audio_cyrb53: 'd' }) };
			const signInLocker = await app.request('http://localhost/api/sign.php', { method: 'POST', headers: otherHeaders, body: JSON.stringify({ user_name: 'locker', password: 'lock-password-1' }) });
			const lockerCookie = signInLocker.headers.get('set-cookie')?.split(';')[0];
			assert.ok(lockerCookie, '乙应该能登录');
			const lockerHeaders = { ...otherHeaders, cookie: lockerCookie, 'x-change-reason': encodeURIComponent('乙的申请') };
			const listed = await (await app.request(`${lockApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
			const victim = listed.table.dataSource.find((row) => row.user_name === 'locked');
			assert.ok(victim, '找得到被操作的那一行');

			// 乙先提一份修改，进队列。
			assert.equal((await app.request(`${lockApi}/${victim.id}`, { method: 'PUT', headers: lockerHeaders, body: JSON.stringify({ status: 'disabled', __changedFields: ['status'] }) })).status, 202);
			// 甲现在什么都动不了，而且话里说得出是谁。
			const blockedEdit = await app.request(`${lockApi}/${victim.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'locked2', __changedFields: ['user_name'] }) });
			assert.equal(blockedEdit.status, 409);
			assert.match((await blockedEdit.json()).feedback?.message ?? '', /乙管理员提交的「修改」申请正在等待审批/);
			// 只改资料表的那一列也拦得住：账号那一行是这条记录的身份（lockRows）。
			// 不声明的话，从页面上看是同一条记录，锁却只锁住了其中一张表。
			const blockedProfile = await app.request(`${lockApi}/${victim.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ profile_nickname: '甲改的', __changedFields: ['profile_nickname'] }) });
			assert.equal(blockedProfile.status, 409, '跨表也要拦：改的是 base_user_profiles，锁挂在 base_users 上');
			const blockedDelete = await app.request(`${lockApi}/${victim.id}`, { method: 'DELETE', headers: { ...headers, cookie }, body: '[]' });
			assert.equal(blockedDelete.status, 409);
			// 乙自己改主意照旧放行，而且覆盖同一条记录，不堆第二条。
			assert.equal((await app.request(`${lockApi}/${victim.id}`, { method: 'PUT', headers: lockerHeaders, body: JSON.stringify({ status: 'locked', __changedFields: ['status'] }) })).status, 202);
			const stillOne = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
			assert.equal(Number(stillOne.prepare("SELECT COUNT(*) AS n FROM base_audits WHERE table_name='base_users' AND row_id=? AND review_status='pending'").get(String(victim.id)).n), 1, '一行上最多一条待审批');
			stillOne.close();
			// 行上那句话：按钮不藏，点进去看到是谁在申请什么。
			const marked = await (await app.request(`${lockApi}?include=schema,data`, { headers: { ...headers, cookie } })).json();
			const lockedRow = marked.table.dataSource.find((row) => String(row.id) === String(victim.id));
			assert.equal(lockedRow._pending, 'update-other');
			assert.match(lockedRow._pending_lock, /乙管理员提交的「修改」申请正在等待审批/);
			const ownView = await (await app.request(`${lockApi}?include=schema,data`, { headers: lockerHeaders })).json();
			const ownRow = ownView.table.dataSource.find((row) => String(row.id) === String(victim.id));
			assert.equal(ownRow._pending, 'update-mine');
			assert.equal(ownRow._pending_lock, '', '自己提的不算被锁住');
			// 清场：驳回乙那条，后面的用例接得上。
			assert.equal((await decide('reject', await pendingIds())).status, 200);
		}

		/**
		 * 批准一条**新建**的配置行之后，接口要立刻读到新值。
		 *
		 * 审批通过是直接把值写回表的，绕过了 configStore 那条会清缓存的路。原先清缓存那一句
		 * 只在「修改」那一支里，而种子只预建了三条站点配置——`tech_stack` 与
		 * `accounts_oidc_client` 的第一次保存走的是 INSERT，于是「批准了但 30 秒内不生效」：
		 * 库里已经是新值，接口读到的还是旧的，等缓存自然过期才对上。
		 *
		 * 改的是 `nginx` 开关而不是 `apiSuffix`：后者改的正是接口地址本身，改完这一段后面的
		 * 请求就得换地址了。
		 */
		{
			const techStack = 'http://localhost/api/panel/admin/base/settings/tech-stack.php';
			assert.equal((await app.request(techStack, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ nginx: true, __changedFields: ['nginx'] }) })).status, 202);
			// 看的是**响应头**，不是这一页读回来的值：`currentValues` 每次都现查库，根本不经过
			// 那层缓存，测不到这个 bug。真正受影响的是 `c.get('techStackConfig')`——每请求从
			// configurationBucket 取，缓存 30 秒。`Server: nginx` 正是从它来的。
			const serverHeader = async () => (await app.request('http://localhost/api/panel/user/base/me.php', { headers: { ...headers, cookie } })).headers.get('server');
			assert.equal(await serverHeader(), null, '还没批准，不该有 nginx 标识');
			assert.equal((await decide('approve', await pendingIds())).status, 200);
			assert.equal(await serverHeader(), 'nginx', '批准新建的配置行之后要立刻生效，不能等缓存过期');
		}

		/**
		 * **改与删只作用在已经生效的那一行上：`queued_at` 必须是 0。**
		 *
		 * 这是一道前置条件，不是在补一个正在漏的洞——眼下走不到，因为改一份还没生效的新建
		 * 根本不会另开申请，而是直接写进去（§13.6 的例外，下面顺带守着）。这里直接把一条
		 * 修改申请指向的行按回队列，验的是那一段 SQL 不会安静地写进一个还不存在的东西里。
		 */
		{
			const pendApi = 'http://localhost/api/panel/admin/base/users.php';
			assert.equal((await app.request(pendApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'pendguy', password: 'pend-password-1', roles: [], status: 'enabled' }) })).status, 202);
			assert.equal((await decide('approve', await pendingIds())).status, 200);
			// 待审批的新建直接改，不另开申请：改的是一份还没生效的东西，没有可批的内容。
			const beforeEdit = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
			const queuedRows = Number(beforeEdit.prepare("SELECT COUNT(*) AS n FROM base_audits WHERE review_status='pending'").get().n);
			beforeEdit.close();
			assert.equal(queuedRows, 0, '批完队列是空的');

			const target = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
			const userId = target.prepare("SELECT id FROM base_users WHERE name='pendguy'").get().id;
			target.close();
			const rowsApi = `http://localhost/api/panel/admin/base/data/rows.php/${userId}?table=base_users&include=data`;
			assert.equal((await app.request(rowsApi, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ status: 'disabled', __changedFields: ['status'] }) })).status, 202);
			const updateIds = await pendingIds();
			// 把这一行按回队列（未生效），再去批那条修改。
			const queue = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
			queue.prepare("UPDATE base_users SET queued_at = 1 WHERE name='pendguy'").run();
			const blocked = await decide('approve', updateIds);
			assert.match((await blocked.json()).feedback?.message ?? '', /还在审批队列里等着生效/);
			assert.equal(queue.prepare("SELECT status FROM base_users WHERE name='pendguy'").get().status, 'enabled', '拦住了就一个字都没写进去');
			// 恢复成已生效，同一条申请立刻批得动——挡住的是那个状态，不是这条申请本身。
			queue.prepare("UPDATE base_users SET queued_at = 0 WHERE name='pendguy'").run();
			assert.equal((await decide('approve', updateIds)).status, 200);
			assert.equal(queue.prepare("SELECT status FROM base_users WHERE name='pendguy'").get().status, 'disabled');
			queue.close();
		}

		/**
		 * 被驳回的申请可以**恢复**：整个操作一起放回队列，行也回到待审批的样子。
		 *
		 * 没有这一条的话，驳回错了只能去每张表的回收站里一行一行捞——建号写三行（账号、
		 * 凭证、资料），捞回账号那一行而漏掉凭证，账号看着正常却登不进去。审批页按操作分组，
		 * 天然一起处理。
		 *
		 * 「恢复」在审批轴（rejected/withdrawn → pending），「重新应用」在数据轴（reverted →
		 * applied），两个名字分开：状态上互斥，但可以先后发生在同一条记录上。
		 */
		assert.equal((await app.request('http://localhost/api/panel/admin/base/audit/records.php?action=requeue', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify([String(queuedInserts[0].id)]) })).status, 200);
		// 只有被否掉的**新增**能恢复：修改/删除/还原重新提交一次就是了，两条路做同一件事，
		// 而多一条路就多一处状态要想。新建不一样——重来要把整张表单再填一遍。
		const requeued = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const backRow = requeued.prepare("SELECT deleted_at, queued_at FROM base_users WHERE name = 'rejectme'").get();
		assert.equal(Number(backRow.deleted_at), 0, '从回收站捞出来');
		assert.notEqual(Number(backRow.queued_at), 0, '重新隐身，等着被批——时间戳取自记录里的 queued_at.before');
		assert.equal(requeued.prepare("SELECT COUNT(*) AS n FROM base_audits WHERE operation_id = ? AND review_status = 'pending'").get(queuedInserts[0].operation_id).n, 3, '只点一条，同一次操作的另外两条跟着回来');
		requeued.close();
		// 批准之后账号真的能用——凭证那一行也跟着回来了。
		assert.equal((await decide('approve', await pendingIds())).status, 200);
		assert.equal((await app.request('http://localhost/api/sign.php', {
			method: 'POST', headers: { ...headers, 'x-device-key': '000000000000400080000000000000ff' },
			body: JSON.stringify({ user_name: 'rejectme', password: 'reject-password-1' }),
		})).status, 200, '捞回来的账号能登录');

		// 列的先后要与 prisma 里的字段顺序一致：两处对照着看时不用来回找。
		// 只比相对次序——不是每个字段都显示（operation_id 就不显示），也允许有计算列。
		const schema = await readFile(resolve(projectDirectory, 'prisma/base.prisma'), 'utf8');
		const model = /model base_audits \{([\s\S]*?)\n\}/.exec(schema);
		assert.ok(model, '找不到 base_audits 模型');
		const schemaOrder = [...model[1].matchAll(/^\s{2}([a-z_]+)\s+\S/gm)].map((match) => match[1]);
		const listed = (await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=schema,data', { headers: { ...headers, cookie } })).json()).table.columns
			.map((column) => column.dataIndex)
			.filter((dataIndex) => schemaOrder.includes(dataIndex));
		assert.deepEqual(listed, schemaOrder.filter((column) => listed.includes(column)), '后台列的先后必须与 prisma 字段顺序一致');

		// 操作的来源域名与接口路径要记进审计：多站点共用一套代码，只记「改了什么」
		// 而不记「在哪改的」，事后分不清是哪个站点的管理员动的手。
		await app.request('https://site-a.test/api/panel/user/base/me.php', { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ _section: 'profile', profile_nickname: '甲甲', profile_qq: '', profile_wechat: '', profile_email: '' }) });
		await app.request('https://site-b.test/api/panel/user/base/me.php', { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ _section: 'profile', profile_nickname: '乙乙', profile_qq: '', profile_wechat: '', profile_email: '' }) });
		const origins = await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=schema,data&review_status=all&table_name=base_user_profiles', { headers: { ...headers, cookie } });
		const originRows = (await origins.json()).table.dataSource;
		assert.ok(originRows.length >= 1, '改昵称要留下审计记录');
		// 记的是去掉后缀的逻辑路径：`.php` 是站点可配的接口后缀，记原样会让同一件事
		// 在审计里长出好几种写法，按路径筛选也就筛不干净。
		// 只看「改」：建号也会写一条资料行，那一条的来路是后台的建号接口，不是个人中心。
		// 个人中心那几条记的是去掉后缀的逻辑路径。不断言「只有这一个」：后台改资料也会写
	// base_user_profiles，那是另一条合法来路，多一条不说明这里出了问题。
	const profilePaths = [...new Set(originRows.filter((row) => row.action === 'update').map((row) => String(row.request_path)))];
	assert.ok(profilePaths.includes('/api/panel/user/base/me'), `个人中心那几条应记成 /api/panel/user/base/me：${profilePaths.join(' ')}`);
	assert.ok(profilePaths.every((path) => !path.includes('.php')), `request_path 不该带接口后缀：${profilePaths.join(' ')}`);
		assert.ok(originRows.some((row) => row.request_hostname === 'site-b.test'), '域名要如实记下来，而不是都记成同一个');
		/**
		 * **成员地址的后缀也要剥掉。**
		 *
		 * 后缀贴在「接口入口」那一段上，后面还可以跟成员 id：`/…/users.php/2`。原先这里
		 * 自己写了一版 `endsWith` 判断，集合地址剥得干净，成员地址一个字都剥不掉——同一件事
		 * 在审计里长出两种写法。现在与路由匹配共用 normalizeApiPath。
		 */
		const memberApi = 'http://localhost/api/panel/admin/base/users.php';
		assert.equal((await app.request(memberApi, { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ user_name: 'pathguy', password: 'path-password-1', roles: [], status: 'enabled' }) })).status, 202);
		assert.equal((await decide('approve', await pendingIds())).status, 200);
		const pathTarget = (await (await app.request(`${memberApi}?include=schema,data`, { headers: { ...headers, cookie } })).json()).table.dataSource.find((row) => row.user_name === 'pathguy');
		assert.equal((await app.request(`${memberApi}/${pathTarget.id}`, { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ status: 'disabled', __changedFields: ['status'] }) })).status, 202);
		const memberRows = (await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=schema,data&table_name=base_users', { headers: { ...headers, cookie } })).json()).table.dataSource;
		const memberPaths = [...new Set(memberRows.map((row) => String(row.request_path)))];
		assert.ok(memberPaths.every((path) => !path.includes('.php')), `request_path 不该带接口后缀：${memberPaths.join(' ')}`);
		assert.ok(memberPaths.includes(`/api/panel/admin/base/users/${pathTarget.id}`), `成员地址剥掉后缀后应是 /api/panel/admin/base/users/<id>：${memberPaths.join(' ')}`);
		assert.equal((await decide('reject', await pendingIds())).status, 200);
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
/**
 * 带布尔列的新建必须批得动。
 *
 * 内容核对的查询一律 `CAST(… AS TEXT)`，而布尔在各方言里读回来长得不一样：SQLite、
 * MySQL、D1 存 0/1，转文本得 `'0'`；PostgreSQL 存 true/false，转文本得 `'false'`。
 * 申请里则是 JSON 的 `false`。不拉平就成死结——批准报「内容与申请不一致」，指向一个
 * 根本不存在的篡改，驳回与撤销倒是照常，于是那条记录再也生效不了。
 * `global_cloud_object_storage_buckets.path_style` 上真的发作过。
 *
 * 直接 seed 而不是走某个接口：要复现的是「申请里是 JSON 布尔、行上是 0/1」这一对，
 * 经哪个接口造出来都一样，而 seed 能顺带把「行被改过」那个反例也摆出来。
 */
const booleanColumnApproval = async () => {
	const directory = await mkdtemp(join(tmpdir(), 'quick-react-audit-boolean-'));
	const previousFile = process.env.DEFAULT_DATABASE_FILE;
	process.env.DEFAULT_DATABASE_FILE = join(directory, 'default.sqlite');
	process.env.SKIP_SERVER_LISTEN = '1';
	try {
		const { app, runMaintenanceAction } = await import(`../dist/server.mjs?audit-boolean=${Date.now()}`);
		await runMaintenanceAction('restore-admin', { user_name: 'booladmin', password: 'audit-password-1' });
		const { DatabaseSync } = await import('node:sqlite');
		const seed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
		const at = Date.now();
		// 两行都还没生效（queued_at 非 0），各挂一条待审批的新建申请。
		const rows = [['bool-ok', '布尔站点', 0], ['bool-tampered', '被改过的站点', 1]];
		for (const [key, title, sso] of rows) {
			seed.prepare('INSERT INTO global_sites (key, created_at, updated_at, queued_at, title, base_site_key, dsn, database_binding, status, migration_status, is_default, is_system, passport_sso_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
				.run(key, at, at, at, title, 'base', '', '', 'enabled', 'ready', 0, 0, sso);
			// 两条申请写的都是「passport_sso_enabled 为 false」。第二行上它已经是 1，
			// 那才是真的被人动过，必须仍然拦下来。
			seed.prepare('INSERT INTO base_audits (key, created_at,updated_at,operation_id,reason,table_name,row_id,row_key,action,changes_before,changes_after,review_status,data_status,settled_at) VALUES (lower(hex(randomblob(16))), ?,?,?,?,?,?,?,?,?,?,?,?,0)')
				.run(at, at, `bool-${key}`, '布尔用例', 'global_sites', String(seed.prepare('SELECT id FROM global_sites WHERE key = ?').get(key).id), key, 'insert', '{}',
					// changes_after 是扁平的 `{列: 值}`，新建那一支的 changes_before 是 `{}`。
					JSON.stringify({ title, is_default: false, passport_sso_enabled: false }),
					'pending', 'unwritten');
		}
		seed.close();
		const headers = {
			'content-type': 'application/json',
			'x-device-key': '00000000000040008000000000000001',
			'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: 'a', audio_cyrb53: 'b' }),
		};
		const login = await app.request('http://localhost/api/sign.php', { method: 'POST', headers, body: JSON.stringify({ user_name: 'booladmin', password: 'audit-password-1' }) });
		const cookie = login.headers.get('set-cookie')?.split(';')[0];
		const listed = await (await app.request('http://localhost/api/panel/admin/base/audit/records.php?include=data&review_status=pending', { headers: { ...headers, cookie } })).json();
		const byRow = new Map(listed.table.dataSource.map((row) => [row.row_key, String(row.id)]));
		const approve = async (rowKey) => {
			const response = await app.request('http://localhost/api/panel/admin/base/audit/records.php?action=approve', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify([byRow.get(rowKey)]) });
			return (await response.json()).feedback?.message ?? '';
		};

		// 全部成功与部分失败是两套文案，这里认前者：一条都不该失败。
		const okMessage = await approve('bool-ok');
		assert.match(okMessage, /已批准 1 条/, `带布尔列的新建要批得动，实际：${okMessage}`);
		const check = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
		assert.equal(String(check.prepare("SELECT queued_at FROM global_sites WHERE key = 'bool-ok'").get().queued_at), '0', '批准之后那一行要真的生效');

		// 反例：行上确实被改过的，仍然要拦下来——布尔归一不能变成无条件放行。
		const tamperedMessage = await approve('bool-tampered');
		assert.match(tamperedMessage, /失败 1 条/, `行上被改过的仍要拦下，实际：${tamperedMessage}`);
		assert.match(tamperedMessage, /内容与申请里的不一致/);
		assert.notEqual(String(check.prepare("SELECT queued_at FROM global_sites WHERE key = 'bool-tampered'").get().queued_at), '0', '被拦下的那一行不能生效');
		check.close();
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
	const { useMemorySnowflake, allSql, createSqliteAdapter, firstSql, auditApprovalsFor, parseAuditChanges, publicAuditChanges, purgeAuditRetention, purgeExpiredAuditEntries, applyAuditApprovals, runOperationSql, runSql, sql, withDatabaseActors } = await import(pathToFileURL(moduleFile));
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

	const entries = async () => (await allSql(acting, sql({ database: acting }).select({ table: 'base_audits', includeAll: true, orderBy: [{ column: 'id', direction: 'ASC' }] }))).map((entry) => ({ ...entry, id: String(entry.id) }));
	// 前后两份值分开存，比对时拼回成对的形状（parseAuditChanges 做的就是这件事）。
	const changesOf = (entry) => parseAuditChanges(entry);
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
	// 不归一的话同样的值再存一次会被判成「变了」，回滚时的值校验也永远匹配不上。
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
	assert.equal((await applyAuditApprovals(acting, [(await latestEntry()).id], 'revert'))[0].ok, true, '写入字符串的那条也要能回滚');
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { roles: 'roles' }, where: [{ column: 'id', value: alice.id }] }))).roles, '["tenant_admin"]');
	assert.equal((await applyAuditApprovals(acting, [arrayEntry.id], 'revert'))[0].ok, true, '数组列必须能回滚');
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
		prepare: (query) => query.startsWith('INSERT INTO "base_audits"') || query.startsWith('UPDATE "base_audits"')
			? { bind: () => ({ run: failWrite, first: failWrite, all: failWrite }) }
			: database.prepare(query),
	}, { subjectRoles: ['platform_admin'], humanOperation: true });
	await assert.rejects(
		() => runOperationSql(context(), failing, sql({ database: failing }).update('base_users', { name: 'alice-4' }, { id: alice.id }), { immediate: true }),
		/audit write failed/,
		'审计写不进去时整个操作必须失败',
	);
	assert.equal((await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { name: 'name' }, where: [{ column: 'id', value: alice.id }] }))).name, 'alice-3', '审计失败后业务数据不应被改动');

	// ---- 回滚（§7）----
	const nameOf = async (id) => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { name: 'name' }, where: [{ column: 'id', value: id }], deleted: 'all' }))).name;
	const statusOf = async (entryId) => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_audits', columns: { data_status: 'data_status' }, where: [{ column: 'id', value: entryId }] }))).data_status;
	const revert = (ids, reason = '') => applyAuditApprovals(acting, ids, 'revert', reason);
	const redo = (ids, reason = '') => applyAuditApprovals(acting, ids, 'redo', reason);
	const entryById = async (id) => (await entries()).find((entry) => entry.id === id);

	// 回滚不新开记录，而是把这一条翻到另一面。
	await op(sql({ database: acting }).update('base_users', { name: 'dave' }, { id: alice.id }));
	const daveEntry = await latestEntry();
	const beforeRevert = (await entries()).length;
	// 「恢复」按钮点在一条已生效的记录上（列表过期）：拒绝，而不是翻成相反方向。
	assert.deepEqual(await redo([daveEntry.id]), [{ id: daveEntry.id, ok: false, message: '当前数据状态是「已生效」，不能执行这个操作' }], { immediate: true });
	assert.equal(await nameOf(alice.id), 'dave', '被拒绝时数据不变');
	assert.deepEqual(await revert([daveEntry.id], '回滚理由：改错了'), [{ id: daveEntry.id, ok: true, message: '已回滚' }]);
	assert.equal(await nameOf(alice.id), 'alice-3', '回滚后字段应恢复原值');
	assert.equal(await statusOf(daveEntry.id), 'reverted');
	assert.equal((await entries()).length, beforeRevert, '回滚不产生新的审计记录');
	// 迁移的操作者、时间与理由**追加成一条事件**：原记录的 created_* 属于原操作者，不能复用。
	const flipped = await entryById(daveEntry.id);
	assert.equal(flipped.reason, daveEntry.reason, '原操作的理由不应被覆盖');
	const flippedEvents = (await auditApprovalsFor(acting, [daveEntry.id])).get(String(daveEntry.id)) ?? [];
	assert.deepEqual(flippedEvents.map((event) => event.kind), ['revert']);
	assert.equal(flippedEvents[0].reason, '回滚理由：改错了');
	assert.ok(Number(flippedEvents[0].created_at) > 0, '要记下什么时候回滚的');

	// 回滚错了就再翻回来，不会堆出一串互相指向的记录。
	//
	// 这一个叫**重新应用**（数据轴：把回滚掉的变更再写回去）。它不是一次决定，只是把已经
	// 批准过的东西再写一遍，因此审批状态一动不动。
	// 审批轴上那个把被驳回/撤销的申请放回队列的叫**恢复**，两个名字分开——见 APPROVAL_KINDS 上的注释。
	assert.deepEqual(await revert([daveEntry.id]), [{ id: daveEntry.id, ok: false, message: '当前数据状态是「已回滚」，不能执行这个操作' }]);
	assert.deepEqual(await redo([daveEntry.id], '重新应用：回滚错了'), [{ id: daveEntry.id, ok: true, message: '已重新应用' }]);
	assert.equal(await nameOf(alice.id), 'dave', '重新应用后应回到变更后的值');
	assert.equal(await statusOf(daveEntry.id), 'applied');
	assert.equal((await entries()).length, beforeRevert, '重新应用同样不产生新记录');
	/**
	 * 每一次迁移各追加一条事件，谁都覆盖不了谁。
	 *
	 * 旧模型把「谁、什么时候、为什么」压进列里，只记得住**最后一次**：一条记录回滚→
	 * 重新应用→再回滚，第一次回滚的理由就没了。事件表下整条经过都在。
	 */
	const restoredEvents = (await auditApprovalsFor(acting, [daveEntry.id])).get(String(daveEntry.id)) ?? [];
	assert.deepEqual(restoredEvents.map((event) => event.kind), ['revert', 'redo']);
	assert.deepEqual(restoredEvents.map((event) => event.reason), ['回滚理由：改错了', '重新应用：回滚错了'], '先发生的那条一个字没被覆盖');
	// 再回滚一次，把数据放回后面用例期望的位置。
	assert.equal((await revert([daveEntry.id]))[0].ok, true);
	assert.equal(await nameOf(alice.id), 'alice-3');

	// 要还原的列在变更之后又被改过时，回滚被拒绝且数据不变。
	await op(sql({ database: acting }).update('base_users', { name: 'erin' }, { id: alice.id }));
	const erinEntry = await latestEntry();
	await op(sql({ database: acting }).update('base_users', { name: 'frank' }, { id: alice.id }));
	const rejected = await revert([erinEntry.id]);
	assert.equal(rejected[0].ok, false);
	assert.match(rejected[0].message, /已被后续修改覆盖/);
	assert.equal(await nameOf(alice.id), 'frank', '回滚被拒绝时数据不变');
	assert.equal(await statusOf(erinEntry.id), 'applied', '被拒绝的记录不应标记为已回滚');

	// 同一行上与本次变更无关的列被改过，不影响回滚。
	await op(sql({ database: acting }).update('base_users', { name: 'grace' }, { id: alice.id }));
	const graceEntry = await latestEntry();
	await op(sql({ database: acting }).update('base_users', { status: 'disabled' }, { id: alice.id }));
	assert.equal((await revert([graceEntry.id]))[0].ok, true, '无关列被改动不应挡住回滚');
	assert.equal(await nameOf(alice.id), 'frank');

	// 同一列的两次连续变更：倒序回滚全部成功，数据回到最初值。
	await op(sql({ database: acting }).update('base_users', { name: 'step-b' }, { id: alice.id }));
	const stepB = await latestEntry();
	await op(sql({ database: acting }).update('base_users', { name: 'step-c' }, { id: alice.id }));
	const stepC = await latestEntry();
	const chained = await revert([stepB.id, stepC.id]);
	assert.deepEqual(chained.map((r) => r.ok), [true, true], '链式变更倒序回滚应全部成功');
	assert.equal(chained[0].id, stepC.id, '执行顺序必须是从新到旧，不沿用传入顺序');
	assert.equal(await nameOf(alice.id), 'frank', '连续回滚后应回到最初值');
	// 恢复方向相反：从旧到新才走得通。
	const restored = await redo([stepC.id, stepB.id]);
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

	// 回滚软删除后回到未删除；再翻回来时 deleted_at 写回**原时间戳**而不是当前时间。
	const deletedAtOf = async () => (await firstSql(acting, sql({ database: acting }).select({ table: 'base_users', columns: { deleted_at: 'deleted_at' }, where: [{ column: 'id', value: alice.id }], deleted: 'all' }))).deleted_at;
	await op(sql({ database: acting }).softDelete('base_users', { id: alice.id }));
	const deleteEntry = await latestEntry();
	const deletedAt = await deletedAtOf();
	assert.equal(deleteEntry.action, 'soft_delete');
	assert.ok(Number(deletedAt) > 0);
	const beforeFlip = (await entries()).length;
	assert.equal((await revert([deleteEntry.id]))[0].ok, true);
	assert.equal(Number(await deletedAtOf()), 0, '回滚软删除后记录应回到未删除');
	assert.equal((await entries()).length, beforeFlip, '回滚软删除不产生新记录');
	assert.equal(await statusOf(deleteEntry.id), 'reverted');
	assert.equal((await redo([deleteEntry.id]))[0].ok, true);
	assert.equal(String(await deletedAtOf()), String(deletedAt), '恢复删除应写回原时间戳，而不是当前时间');
	assert.equal((await revert([deleteEntry.id]))[0].ok, true);
	assert.equal(Number(await deletedAtOf()), 0);

	// ---- 凭证列：照常记录、照常回滚，只是接口不返回值（§5）----
	// 凭证与账号资料分表；password 是 JSON 列（存 { hash, pattern }），前后值都记成对象。
	await runSql(acting, sql({ database: acting }).insert('base_user_credentials', { user_id: alice.id, password: { hash: 'hash-1', pattern: 'LLLL' } }));
	await op(sql({ database: acting }).update('base_user_credentials', { password: { hash: 'hash-2', pattern: 'LLLL' } }, { user_id: alice.id }));
	const passwordEntry = await latestEntry();
	const storedChanges = parseAuditChanges(passwordEntry);
	// 只记变了的键：pattern 没变就不进记录。回滚按键合并回去，下面那条断言验证了合并结果。
	assert.deepEqual(storedChanges.password, { before: { hash: 'hash-1' }, after: { hash: 'hash-2' } }, '存储层只记变化的键，且不做加密');
	assert.deepEqual(publicAuditChanges(storedChanges), { password: { hidden: true } }, '接口不得返回凭证值');
	assert.equal((await revert([passwordEntry.id]))[0].ok, true, '凭证列仍然可以回滚');
	// 比对象而不是比 JSON 文本：键序在 JSON 里没有语义，拿文本比会为了一个无关的差别失败。
	// 回滚只写回记录里提到的键（hash），没提到的（pattern）保持当前值——这正是差异存储换来的：
	// 中途被别人改过的其他键不会被一起抹掉。
	assert.deepEqual(JSON.parse((await firstSql(acting, sql({ database: acting }).select({ table: 'base_user_credentials', columns: { password: 'password' }, where: [{ column: 'user_id', value: alice.id }] }))).password), { hash: 'hash-1', pattern: 'LLLL' }, '回滚后凭证应还原');

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
	assert.deepEqual(parseAuditChanges(resubmitted).roles, { before: [], after: ['branch_admin'] });
	/**
	 * 换个人提交同一行：**一行上同时只能有一条申请在队列里**，第二条进不来。
	 *
	 * 拦住它的是数据库那条唯一索引 `(table_name, row_key, settled_at)`——排队中的记 0，
	 * 了结的各带一个时间戳，于是同一行的第二条 pending 撞上前一条。应用层的行锁
	 * （findConflictingPending）在这里认不出「我是谁」（模块级调用没有 currentUser），
	 * 正好露出这道兜底。裸的 UNIQUE 错误换成了和行锁一致的说法。
	 */
	const otherActor = withDatabaseActors(counting, { subjectRoles: ['platform_admin'], humanOperation: true, base: '99' });
	await assert.rejects(
		() => runOperationSql(context('另一个人的申请'), otherActor, sql({ database: otherActor }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })),
		(error) => /一行上同时只能有一条/.test(String(error?.message ?? '')),
		'第二条申请该被数据库那条唯一索引拦下，并且给的是人话',
	);
	assert.equal((await entries()).length, beforeResubmit, '一行上同时只能有一条在队列里');
	// 第二条压根没进来，因此没有多余的记录要清理——原先那条还在队列里排着。
	// 把它改回原先的值，后面的断言接得上（同一个人同一动作，覆盖上一条）。
	await assert.rejects(() => runOperationSql(context('申请调整角色'), acting, sql({ database: acting }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })));

	// 先提交待审批、再直写同一行（路由内部的机器写入）：作废的申请被覆盖，不留孤儿记录。
	const beforeSupersede = (await entries()).length;
	await runOperationSql(context('这次直接生效'), acting, sql({ database: acting }).update('base_users', { roles: '["platform_support"]' }, { id: alice.id }), { immediate: true });
	assert.equal((await entries()).length, beforeSupersede, '直写应覆盖自己那条待审批记录，而不是再插一条');
	const superseded = await entryById(pendingEntry.id);
	assert.equal(superseded.review_status, 'none', '直写不是审批');
	assert.equal(superseded.data_status, 'applied');
	assert.equal(superseded.reason, '这次直接生效');
	assert.equal((await auditApprovalsFor(acting, [pendingEntry.id])).get(String(pendingEntry.id)), undefined, '直写不是审批，不该冒出一条审批事件');
	assert.equal(await rolesOf(), '["platform_support"]');
	// 复位，后面的断言接得上。
	await runOperationSql(context('复位'), acting, sql({ database: acting }).update('base_users', { roles: originalRoles }, { id: alice.id }), { immediate: true });
	await assert.rejects(() => runOperationSql(context('申请调整角色'), acting, sql({ database: acting }).update('base_users', { roles: '["tenant_admin"]' }, { id: alice.id })));
	pendingEntry = await latestEntry();

	// 待审批的记录不能回滚，只能批准或驳回。
	assert.equal((await revert([pendingEntry.id]))[0].message, '当前数据状态是「未写入」，不能执行这个操作');

	// 批准：把 after 写进去，并记下审批人与意见。
	assert.deepEqual(await applyAuditApprovals(acting, [pendingEntry.id], 'approve', '同意'), [{ id: pendingEntry.id, ok: true, message: '已批准' }]);
	assert.equal(await rolesOf(), '["tenant_admin"]', '批准后修改才生效');
	const approved = await entryById(pendingEntry.id);
	assert.equal(approved.review_status, 'approved', '走完队列的才叫已批准');
	assert.equal(approved.data_status, 'applied');
	const approveEvents = (await auditApprovalsFor(acting, [pendingEntry.id])).get(String(pendingEntry.id)) ?? [];
	assert.deepEqual(approveEvents.map((event) => [event.kind, event.reason]), [['approve', '同意']]);
	assert.ok(Number(approveEvents[0].created_at) > 0, '要记下什么时候批的');

	// 批准过的可以再回滚，回滚信息不会覆盖掉「谁批准的」。
	assert.equal((await revert([pendingEntry.id], '批错了'))[0].ok, true);
	const afterRevert = await entryById(pendingEntry.id);
	// 两列正交：回滚只把数据翻回去，「是谁放行的」原样留着。合成一列时这条信息会被冲掉。
	assert.equal(afterRevert.review_status, 'approved', '回滚不该改动审批状态');
	assert.equal(afterRevert.data_status, 'reverted');
	// 事件一条条追加：回滚这条盖不掉「谁批准的、批注写了什么」。
	assert.deepEqual(
		((await auditApprovalsFor(acting, [pendingEntry.id])).get(String(pendingEntry.id)) ?? []).map((event) => [event.kind, event.reason]),
		[['approve', '同意'], ['revert', '批错了']],
	);
	assert.equal(await rolesOf(), originalRoles);

	// 撤销自己一条事件：它和审批都从 pending 出发，但一个是审批人的决定、
	// 一个是申请人自己收回，混在一起就分不清那一条记的是谁。
	await assert.rejects(() => runOperationSql(context('申请改名'), acting, sql({ database: acting }).update('base_users', { name: 'withdrawn-name' }, { id: alice.id })));
	const withdrawEntry = await latestEntry();
	assert.deepEqual(await applyAuditApprovals(acting, [withdrawEntry.id], 'withdraw', ''), [{ id: withdrawEntry.id, ok: true, message: '已撤销' }]);
	const withdrawn = await entryById(withdrawEntry.id);
	assert.equal(withdrawn.review_status, 'withdrawn');
	assert.equal(withdrawn.data_status, 'unwritten', '撤销的申请从未写入');
	const withdrawEvents = (await auditApprovalsFor(acting, [withdrawEntry.id])).get(String(withdrawEntry.id)) ?? [];
	assert.deepEqual(withdrawEvents.map((event) => event.kind), ['withdraw'], '只有一条撤销事件——它不是审批，也不是回滚');
	assert.ok(Number(withdrawEvents[0].created_at) > 0, '要记下什么时候撤销的');
	assert.equal(withdrawEvents[0].reason, '', '撤销没有理由：申请人收回自己提的东西，不需要向谁交代');
	assert.equal(await nameOf(alice.id), 'frank', '撤销不该改动数据');
	// 撤销是终态，和驳回一样不能再迁移。
	assert.equal((await applyAuditApprovals(acting, [withdrawEntry.id], 'approve', ''))[0].ok, false);

	// 驳回：不碰数据，只落状态。
	await assert.rejects(() => runOperationSql(context('申请改名'), acting, sql({ database: acting }).update('base_users', { name: 'rejected-name' }, { id: alice.id })));
	const rejectEntry = await latestEntry();
	assert.deepEqual(await applyAuditApprovals(acting, [rejectEntry.id], 'reject', '不同意'), [{ id: rejectEntry.id, ok: true, message: '已驳回' }]);
	assert.equal(await nameOf(alice.id), 'frank', '驳回不该改动数据');
	assert.equal((await entryById(rejectEntry.id)).review_status, 'rejected');
	// 驳回是终态，不能再迁移。
	assert.equal((await applyAuditApprovals(acting, [rejectEntry.id], 'approve'))[0].message, '当前审批状态是「已驳回」，不能执行这个操作');

	// 非管理员就算发了 X-Change-Immediate 也照样进队列：放行由服务端角色说了算。
	const forged = { req: context('').req, get: (key) => key === 'effectiveRoles' ? ['user'] : undefined, set: () => {} };
	await assert.rejects(
		() => runOperationSql(forged, acting, sql({ database: acting }).update('base_users', { name: 'forged' }, { id: alice.id })),
		(error) => error instanceof PendingApprovalError,
		'非管理员伪造请求头不能跳过审批',
	);
	assert.equal(await nameOf(alice.id), 'frank');
	await applyAuditApprovals(acting, [(await latestEntry()).id], 'reject', '清理测试数据');

	// 列表支持按状态、数据表、记录与原因关键字筛选。
	const { listAuditEntries } = await import(pathToFileURL(moduleFile));
	const pendingOnly = await listAuditEntries(acting, [{ column: 'review_status', value: 'pending' }]);
	assert.ok(pendingOnly.every((entry) => entry.review_status === 'pending'), '按审批状态筛选');
	const selfOnly = await listAuditEntries(acting, [{ column: 'scope', value: 'self' }]);
	assert.ok(selfOnly.every((entry) => entry.scope === 'self'), '按来源筛选');
	const byTable = await listAuditEntries(acting, [{ column: 'table_name', value: 'base_users' }]);
	assert.ok(byTable.length && byTable.every((entry) => entry.table_name === 'base_users'), '按数据表筛选');
	// 匹配的是提交时填的「操作原因」，不含回滚理由与审批意见——那两个各有自己的列。
	const byReason = await listAuditEntries(acting, [], '批量调整');
	assert.ok(byReason.length && byReason.every((entry) => entry.reason.includes('批量调整')), '按原因模糊匹配');
	assert.deepEqual(await listAuditEntries(acting, [], '这段文字不存在'), []);
	// 搜索框是**三态**的：没这个参数是不筛，空串是「填了，找空的」，有字才按字筛。
	// 压成两态的话根本没办法搜空值——想找出哪几条申请没写操作原因，把框清掉就等于取消筛选。
	const emptyReason = await listAuditEntries(acting, [], '');
	assert.ok(emptyReason.every((entry) => !entry.reason), '空串筛出来的每一条都是没写操作原因的');
	const noReasonFilter = await listAuditEntries(acting, []);
	assert.notEqual(noReasonFilter.length, emptyReason.length, '空串不等于不筛：原先这两者是同一个东西，于是空值搜不出来');
	// 下拉框不摆「全部」：空着就是不加这个条件，占位文字写着「未填写」，与文本框同一套说法。
	// 「全部」是「不筛选」的第二种拼法，两种摆在一个控件里，看的人先得琢磨它们差在哪。
	const auditRoute = await readFile(resolve(projectDirectory, 'server/routes/base/api/panel/admin/base/audit/records.mts'), 'utf8');
	assert.doesNotMatch(auditRoute, /text: '全部'/, '审批页的下拉框不该再摆「全部」这一项');
	const tableCrudSource = await readFile(resolve(projectDirectory, 'src/utils/antd/table_crud/index.tsx'), 'utf8');
	assert.match(tableCrudSource, /placeholder=\{field\.placeholder \?\? '未填写'\}/, '下拉框空着的时候要讲清楚那是「未填写」');
	// 有默认值的下拉框是这一页运转所必需的（数据管理的「数据表」、对象存储的「Bucket 绑定」），
	// 清空了页面就没东西可显示，那不是一种筛选状态；没有默认值的才给清。
	assert.match(tableCrudSource, /allowClear=\{field\.defaultValue === undefined\}/);
	assert.doesNotMatch(auditRoute, /\{ value: '', text: '全部' \}/);
	await auditRouteFilter();
	await booleanColumnApproval();

	// ---- 保留期（§10）----
	const total = (await entries()).length;
	assert.equal(await purgeExpiredAuditEntries(database, 0), 0, '保留期为 0 表示不自动清理');
	assert.equal((await entries()).length, total);
	/**
	 * 保留期按 `settled_at` 算，而且**只清已经了结的**。
	 *
	 * 从「了结」起算：按提交时刻算的话，一条提交一年后才批准的申请，批准当天就到期该清了。
	 * 只清已了结的：一条卡在队列里超过保留期的**新建**申请要是被删掉，它那一行还带着
	 * `queued_at != 0` 躺在库里——谁也看不见、谁也批不了、也不在回收站，连带把那个名字
	 * 永久占住。下面单独验这一条。
	 */
	const staleAt = Date.now() - 400 * 86400_000;
	const settledOnes = (await entries()).filter((entry) => String(entry.settled_at) !== '0').slice(0, 3).map((entry) => entry.id);
	assert.equal(settledOnes.length, 3, '得有三条已了结的记录可清');
	// 各给一个时刻：同一行的多条历史记录共用一个 settled_at 会撞上那条唯一索引。
	settledOnes.forEach((id, index) => database.prepare('UPDATE base_audits SET settled_at = ? WHERE id = ?').bind(staleAt + index, id).run());
	assert.equal(await purgeExpiredAuditEntries(database, 365, { batchSize: 2 }), 3, '过期记录应被物理删除，且分批可重入');
	assert.equal((await entries()).length, total - 3, '未到期的记录不受影响');
	assert.equal(await purgeExpiredAuditEntries(database, 365), 0, '再跑一次没有可清理的记录');
	// 还在队列里的：做旧到多久都不清。清掉它就会留下一个谁也处理不了的幽灵行。
	const queuedEntry = (await entries()).find((entry) => entry.review_status === 'pending');
	if (queuedEntry) {
		database.prepare('UPDATE base_audits SET created_at = ? WHERE id = ?').bind(staleAt, queuedEntry.id).run();
		assert.equal(await purgeExpiredAuditEntries(database, 365), 0, '还在队列里的申请不该被保留期清走');
		assert.ok((await entries()).some((entry) => String(entry.id) === String(queuedEntry.id)), '它得还在');
	}

	// 保留期按租户独立：读各租户自己的站点设置。
	await runSql(database, sql({ database }).ignoreInsert('base_tenants', ['name'], { name: 'default', title: '默认租户', status: 'enabled' }));
	const remaining = (await entries()).find((entry) => String(entry.owner_tid) === '1' && String(entry.settled_at) !== '0');
	database.prepare('UPDATE base_audits SET settled_at = ? WHERE id = ?').bind(staleAt, remaining.id).run();
	assert.equal(await purgeAuditRetention(database), 1, '未配置保留期的租户应回落到默认的 365 天');

	// 空串与 NULL 都念作「空」：在「改了什么」这个问题上它们是同一件事——原来没有值。
	// 不这么念的话空串渲染成空白，摘要读起来是 `微信号： → 1`，一个断掉的箭头。
	// 要分清是 NULL 还是空串，看的是数据管理那张原始表（那里 NULL 单独标出来）。
	assert.equal(describeAuditChanges({ wechat: { before: '', after: '1' } }), 'wechat：空 → 1', '空串念「空」');
	assert.equal(describeAuditChanges({ wechat: { before: null, after: '1' } }), 'wechat：未填写 → 1', 'NULL 是人选的，念「未填写」');
	assert.equal(describeAuditChanges({ wechat: { before: undefined, after: '1' } }), 'wechat：空 → 1', '键不存在什么也没说，念「空」');
	assert.equal(describeAuditChanges({ wechat: { before: '1', after: '' } }), 'wechat：1 → 空');

	console.log('change audit ok');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
