import assert from 'node:assert/strict';
import { readTableUrlState, writeTableUrlState, sortOrderFor, parseSort, formatSort, mergeSort, defaultTableUrlState } from '@/utils/antd/table_crud/url-state.js';

// —— 读 ——
assert.deepEqual(readTableUrlState(''), { ...defaultTableUrlState, query: {} });
assert.deepEqual(readTableUrlState('?page=3&size=50&sort=user_name:desc&q.user_name=adm&q.status=enabled'), {
	page: 3, size: 50, sort: 'user_name:desc', query: { user_name: 'adm', status: 'enabled' },
});
// 搜索字段带 q. 前缀，因此不会和通用参数撞名：这里的 page 是翻页，不是某个叫 page 的搜索字段。
assert.deepEqual(readTableUrlState('?page=2&q.page=7').query, { page: '7' });
// 乱填的值回落到默认，不让一个坏链接把表格弄崩。
for (const bad of ['?page=0', '?page=-1', '?page=abc', '?page=']) assert.equal(readTableUrlState(bad).page, 1, bad);
for (const bad of ['?size=0', '?size=x']) assert.equal(readTableUrlState(bad).size, 10, bad);

// —— 写 ——
// 默认值不写进地址：默认状态下地址栏保持干净。
assert.equal(writeTableUrlState('', { page: 1, size: 10, sort: '' }), '');
assert.equal(writeTableUrlState('?page=3&size=50&sort=id:asc', { page: 1, size: 10, sort: '' }), '');
assert.equal(writeTableUrlState('', { page: 3 }), 'page=3');
assert.equal(writeTableUrlState('', { sort: 'created_at:desc' }), 'sort=created_at%3Adesc');
// 只给一部分字段时，其余保持原样。
assert.equal(writeTableUrlState('?page=3&sort=id:asc', { page: 5 }), 'page=5&sort=id%3Aasc');
// 页面自身的其它查询参数（例如选项卡）不能被表格状态顺手清掉。
assert.match(writeTableUrlState('?tab=profile&page=2', { page: 4 }), /tab=profile/);
// 搜索条件整体替换：上一次的条件不能残留下来。
assert.equal(writeTableUrlState('?q.old=1', { query: { user_name: 'adm' } }), 'q.user_name=adm');
assert.equal(writeTableUrlState('?q.old=1', { query: {} }), '');
// 空串等于没填，不进地址。
assert.equal(writeTableUrlState('', { query: { user_name: '', status: 'enabled' } }), 'q.status=enabled');

// —— 读写往返 ——
const roundTrip = { page: 4, size: 20, sort: 'status:desc', query: { user_name: 'adm' } };
assert.deepEqual(readTableUrlState('?' + writeTableUrlState('', roundTrip)), roundTrip);

// —— antd 排序状态换算 ——
assert.equal(sortOrderFor('user_name:desc', 'user_name'), 'descend');
assert.equal(sortOrderFor('user_name:asc', 'user_name'), 'ascend');
assert.equal(sortOrderFor('user_name', 'user_name'), 'ascend', '没写方向按升序');
assert.equal(sortOrderFor('user_name:desc', 'status'), null, '别的列不该显示排序箭头');
assert.equal(sortOrderFor('', 'user_name'), null);

// —— 多列排序 ——
assert.deepEqual(parseSort('status:asc,user_name:desc'), [
	{ field: 'status', order: 'ascend' }, { field: 'user_name', order: 'descend' },
]);
assert.deepEqual(parseSort(''), []);
assert.deepEqual(parseSort('a:asc,,b:desc').map((e) => e.field), ['a', 'b'], '空段跳过');
assert.equal(formatSort(parseSort('status:asc,user_name:desc')), 'status:asc,user_name:desc', '往返一致');
// 多列时每一列各自显示自己的箭头。
assert.equal(sortOrderFor('status:asc,user_name:desc', 'status'), 'ascend');
assert.equal(sortOrderFor('status:asc,user_name:desc', 'user_name'), 'descend');

// —— 合并 antd 回调：已在排的保持先后，新点的排到末尾 ——
assert.equal(mergeSort('', [{ field: 'status', order: 'ascend' }]), 'status:asc');
assert.equal(mergeSort('status:asc', [{ field: 'status', order: 'ascend' }, { field: 'user_name', order: 'descend' }]),
	'status:asc,user_name:desc', '新点的列排到末尾，不打乱已有次序');
// 就算 antd 把新列放在数组前面，已有列的先后也不变——"再按某列细分"是往后加一层。
assert.equal(mergeSort('status:asc', [{ field: 'user_name', order: 'descend' }, { field: 'status', order: 'ascend' }]),
	'status:asc,user_name:desc');
// 同一列换方向：位置不动，只改方向。
assert.equal(mergeSort('status:asc,user_name:desc', [{ field: 'status', order: 'descend' }, { field: 'user_name', order: 'descend' }]),
	'status:desc,user_name:desc');
// 取消某一列的排序就把它去掉。
assert.equal(mergeSort('status:asc,user_name:desc', [{ field: 'user_name', order: 'descend' }]), 'user_name:desc');
assert.equal(mergeSort('status:asc', [{ field: 'status', order: undefined }]), '', '取消排序回到后端默认次序');
assert.equal(mergeSort('status:asc', []), '');
// antd 的 dataIndex 可能是数组路径。
assert.equal(mergeSort('', [{ field: ['a', 'b'], order: 'ascend' }]), 'a.b:asc');

console.log('table url state test passed');
