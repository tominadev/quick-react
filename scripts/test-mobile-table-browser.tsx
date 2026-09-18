import assert from 'node:assert/strict';
import { setupBrowserDom, assertAbsent } from './browser-dom.mjs';

/**
 * 手机版表格必须把后端下发的动作**全部**渲染出来。
 *
 * 这个测试的由来：`MobileTable` 早先只渲染 `actions.row`，`toolbar` 和 `queryFields`
 * 根本没实现，还额外把 `edit`、带表单的、带弹窗的行动作过滤掉。后端按统一协议下发了
 * 这些东西，手机上就是没有那个按钮，而且控制台一个错都不报——和对象存储「上传」消失
 * 的表现一模一样，只是原因在前端这一侧。
 *
 * 因此这里盯的是「后端说有的，界面上就得有」：查询字段要摆出来、默认值要带进请求、
 * 工具栏和行动作一个都不能少，以及做完之后走的是服务端的 next 而不是前端自己猜。
 */
const dom = setupBrowserDom('https://m.site.test/panel/user/sms/phones.html');

const React = await import('react');
const { render, screen, waitFor } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const MobileTable = (await import('../clients/antd-mobile/components/MobileTable.js')).default;

/**
 * 照着对象存储那一页搭：查询字段带服务端默认值（第一次请求必然不带它），
 * 工具栏有上传，行上是「进入 / 下载 / 删除」三选一。
 */
const queryFields = [
	{ dataIndex: 'binding_id', label: '站点 Bucket 绑定', component: 'select', options: [{ value: '1', text: 'minio / sms' }], defaultValue: '1' },
	{ dataIndex: 'prefix', label: '对象前缀', component: 'textbox', placeholder: '可选' },
];
const tableOption = {
	rowKey: 'key',
	queryFields,
	actions: {
		query: [{ key: 'search', label: '查询' }],
		toolbar: [{ key: 'upload', label: '上传' }],
		row: [
			{ key: 'enter', label: '进入', applyQueryFields: { prefix: 'relative_key' }, visibleWhen: { field: 'is_prefix', values: ['1'] } },
			{ key: 'download', label: '下载', visibleWhen: { field: 'is_prefix', values: ['0'] } },
			{ key: 'delete', label: '删除', confirm: '确认删除对象吗？', visibleWhen: { field: 'is_prefix', values: ['0'] } },
		],
	},
};
const columns = [
	{ dataIndex: 'name', title: '名称', component: 'textbox' },
	{ dataIndex: 'size', title: '大小', component: 'textbox' },
];
const rowsForPrefix = (prefix: string) => prefix === 'shortcuts/'
	? [{ key: 'shortcuts/a.txt', name: 'a.txt', size: 12, relative_key: 'shortcuts/a.txt', is_prefix: '0' }]
	: [{ key: 'shortcuts/', name: 'shortcuts/', size: 0, relative_key: 'shortcuts/', is_prefix: '1' }];

const requests: string[] = [];
const deleted: unknown[] = [];
const commonApi = {
	apiFetch: async (url: string, init?: RequestInit) => {
		requests.push(String(url));
		if (init?.method === 'DELETE') {
			deleted.push(JSON.parse(String(init.body)));
			return new Response(JSON.stringify({ feedback: { component: 'none' } }), { headers: { 'content-type': 'application/json' } });
		}
		const parsed = new URL(String(url), 'https://m.site.test');
		const binding = parsed.searchParams.get('binding_id');
		const prefix = parsed.searchParams.get('prefix') ?? '';
		// 没带绑定时后端回的是空列表——但结构必须是完整的那一份（架构文档：结构只有第一帧那一次机会）。
		const dataSource = binding ? rowsForPrefix(prefix) : [];
		const schema = parsed.searchParams.get('include')?.includes('schema');
		return new Response(JSON.stringify({
			table: schema
				? { option: tableOption, columns, dataSource, totalRecords: dataSource.length }
				: { dataSource, totalRecords: dataSource.length },
		}), { headers: { 'content-type': 'application/json' } });
	},
	modalConfirm: async () => true,
	modalConfirmWithReason: async () => ({ reason: '测试' }),
	modalError: async () => {},
	uploadFile: async () => {},
};

const user = userEvent.setup({ document: dom.window.document });
render(React.createElement(MobileTable, { commonApi, resourcePath: '/panel/admin/global/cloud/object-storage/objects', title: '对象管理' }));

// 服务端给的默认值必须自己带回去再查一次：第一次请求不可能带 binding_id，
// 它的默认值就在这次响应里。不带的话这一页永远停在空列表上。
await waitFor(() => assert.ok(requests.some((url) => url.includes('binding_id=1')), `默认查询值没有带进请求：${requests.join(' | ')}`));
await waitFor(() => assert.ok(screen.getByText('shortcuts/')));

// 查询字段要摆出来，否则这一页在手机上根本没法换绑定或换目录。
assert.ok(screen.getByText('站点 Bucket 绑定'), '查询字段要渲染');
assert.ok(screen.getByText('对象前缀'), '查询字段要渲染');
assert.ok(screen.getByRole('button', { name: /查询/ }), '查询动作要渲染');

// 工具栏动作一个都不能吞：这正是「上传」消失的那一处。
assert.ok(screen.getByRole('button', { name: /上传/ }), '工具栏动作要渲染');

// 目录行只出现「进入」，文件行才有下载与删除——互斥判据由服务端的 visibleWhen 给。
assert.ok(screen.getByRole('button', { name: /进入/ }), '目录行要有进入');
assertAbsent(screen.queryByRole('button', { name: /下载/ }), '目录行不该出现下载');

// 「进入」是换查询条件重查，不是另开页面。
await user.click(screen.getByRole('button', { name: /进入/ }));
await waitFor(() => assert.ok(requests.some((url) => url.includes('prefix=shortcuts%2F')), `进入目录没有带上 prefix：${requests.join(' | ')}`));
await waitFor(() => assert.ok(screen.getByText('a.txt')));
assert.ok(screen.getByRole('button', { name: /下载/ }), '文件行要有下载');

// 删除走 DELETE 加主键数组，与桌面版同一条协议。
await user.click(screen.getByRole('button', { name: /删除/ }));
await waitFor(() => assert.deepEqual(deleted, [['shortcuts/a.txt']], '删除要按主键发过去'));

// 结构只在第一次请求里取，之后只要数据——算错的话每翻一页都重取一遍结构。
const schemaRequests = requests.filter((url) => url.includes('include=') && url.includes('schema'));
assert.equal(schemaRequests.length, 1, `结构只该取一次，实际取了 ${schemaRequests.length} 次`);

console.log('mobile table test passed');
