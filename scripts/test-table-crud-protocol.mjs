import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/**
 * 表格 CRUD 的协议层。
 *
 * 这几条规则是**后端驱动 UI 协议的一部分**，第二套 UI（elementUI、手机版、小程序）必须
 * 一字不差地照做：`include` 算错就会每次翻页都重取一遍结构，`visibleWhen` 判错就会把
 * 「回滚」显示在一条已经回滚过的记录上。这种漂移在复制代码的那一刻看不出来，要等用户
 * 报障才发现——所以规则单独成模块，并且在这里钉死。
 */
const directory = await mkdtemp(join(tmpdir(), 'quick-react-table-crud-'));
try {
	const result = await build({
		stdin: { contents: "export * from './clients/web/utils/common/table-crud.ts';", resolveDir: resolve(import.meta.dirname, '..'), sourcefile: 'table-crud-entry.ts' },
		bundle: true, format: 'esm', platform: 'neutral', write: false,
		alias: { '@': resolve(import.meta.dirname, '../clients/web'), '@clients': resolve(import.meta.dirname, '../clients'), '@shared': resolve(import.meta.dirname, '../shared') },
	});
	const file = join(directory, 'table-crud.mjs');
	await writeFile(file, result.outputFiles[0].contents);
	const { nextIncludes, tableRequestQuery, pageTotal, actionVisibleForRow, withoutControlFields, rowConfirmText, formatBytes, responseHasSchema } = await import(pathToFileURL(file));

	// ---- include：首次取结构，之后只取数据 ----
	assert.equal(nextIncludes(undefined, false), 'data,schema');
	assert.equal(nextIncludes(undefined, true), 'data', '结构取过一次就不再重取——它在同一张表上不会变');
	// 业务 include 要留着：它决定「取哪一批行」，与结构无关。
	assert.equal(nextIncludes('deleted', false), 'deleted,data,schema');
	assert.equal(nextIncludes('deleted', true), 'deleted,data', '回收站状态在后续请求里也要保留');

	// ---- 请求参数 ----
	const first = tableRequestQuery({ page: 1, pageSize: 10, queryValues: { status: 'enabled' }, schemaLoaded: false });
	assert.equal(first.pageNum, '1');
	assert.equal(first.status, 'enabled');
	assert.equal(first.include, 'data,schema');
	assert.ok(!('cursor' in first), '没有游标就不要带——带一个空的会被当成「从头开始」');
	assert.ok(!('sort' in first));
	const cursored = tableRequestQuery({ page: 2, pageSize: 10, sort: 'id:desc', cursor: 'abc', queryValues: {}, schemaLoaded: true });
	assert.equal(cursored.cursor, 'abc');
	assert.equal(cursored.sort, 'id:desc');
	assert.equal(cursored.include, 'data');
	// include 是协议参数，业务字段里同名的不能盖掉它
	assert.equal(tableRequestQuery({ page: 1, pageSize: 10, queryValues: { include: 'deleted' }, schemaLoaded: true }).include, 'deleted,data');

	// ---- 翻页总数 ----
	assert.equal(pageTotal({ page: 1, pageSize: 10, currentCount: 10, totalRecords: 87 }), 87, '普通分页用服务端给的真实总数');
	// 游标分页不知道总数：多出来的那个 1 让「下一页」点得动，而不是显示一个假的准确值。
	assert.equal(pageTotal({ page: 1, pageSize: 10, currentCount: 10, hasMore: true }), 11);
	assert.equal(pageTotal({ page: 1, pageSize: 10, currentCount: 7, hasMore: false }), 7);
	assert.equal(pageTotal({ page: 3, pageSize: 10, currentCount: 4, hasMore: false }), 24, '前面翻过的页数要算进去');

	// ---- 行动作可见性：互斥的两个动作，一行上永远只出现一个 ----
	const revert = { key: 'revert', label: '回滚', visibleWhen: { field: 'data_status', values: ['applied'] } };
	const redo = { key: 'redo', label: '重新应用', visibleWhen: { field: 'data_status', values: ['reverted'] } };
	assert.equal(actionVisibleForRow(revert, { data_status: 'applied' }), true);
	assert.equal(actionVisibleForRow(redo, { data_status: 'applied' }), false);
	assert.equal(actionVisibleForRow(revert, { data_status: 'reverted' }), false);
	assert.equal(actionVisibleForRow({ key: 'edit', label: '编辑' }, { data_status: 'applied' }), true, '没声明 visibleWhen 就一直显示');
	// 缺字段读成空串，而不是崩掉或一律显示
	assert.equal(actionVisibleForRow(revert, {}), false);
	assert.equal(actionVisibleForRow({ key: 'x', label: 'x', visibleWhen: { field: 'f', values: [''] } }, {}), true);

	// ---- 控制字段走请求头，不混进业务字段 ----
	const cleaned = withoutControlFields({ name: 'x', _change: { reason: '客诉' } });
	assert.deepEqual(cleaned, { name: 'x' });

	// ---- 确认文案里插本行的值；缺值时原样保留占位符，不显示 undefined ----
	assert.equal(rowConfirmText('确认删除 {user_name} 吗？', { user_name: '张三' }), '确认删除 张三 吗？');
	assert.equal(rowConfirmText('确认删除 {user_name} 吗？', {}), '确认删除 {user_name} 吗？');
	assert.equal(rowConfirmText('确认删除 {user_name} 吗？', { user_name: '' }), '确认删除 {user_name} 吗？');

	// ---- 文件大小 ----
	assert.equal(formatBytes(0), '0 B');
	assert.equal(formatBytes(-1), '0 B');
	assert.equal(formatBytes(512), '512 B');
	assert.equal(formatBytes(1024), '1.00 KB');
	assert.equal(formatBytes(3.2 * 1024 ** 2), '3.20 MB');

	assert.equal(responseHasSchema({ columns: [] }), true);
	assert.equal(responseHasSchema({ dataSource: [] }), false, '只回数据的响应不该把结构标记成已加载');
	assert.equal(responseHasSchema(undefined), false);

	console.log('table crud protocol test passed');
} finally {
	await rm(directory, { recursive: true, force: true });
}
