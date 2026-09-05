import assert from 'node:assert/strict';
import { readTableUrlState, writeTableUrlState, sortOrderFor, parseSort, formatSort, mergeSort, mergeQueryValues, queryUrlValues, tableRequestParams, defaultTableUrlState } from '@/utils/antd/table_crud/url-state.js';

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

// —— 查询条件的三个来源 ——
const auditFields = [{ dataIndex: 'review_status', defaultValue: 'pending' }, { dataIndex: 'reason' }];
// 什么都没给：用后端下发的默认值。
assert.deepEqual(mergeQueryValues(auditFields, {}, {}), { review_status: 'pending' });
// 地址栏压过默认值——审计页默认「待审批」，用户改成「全部」再刷新，挑的不能白挑。
assert.deepEqual(mergeQueryValues(auditFields, {}, { review_status: 'all' }), { review_status: 'all' });
assert.deepEqual(mergeQueryValues(auditFields, {}, { review_status: '' }), { review_status: '' }, '空串也是明确的选择，不能回落到默认值');
// 页面初始值压过字段默认值，地址栏又压过它。
assert.deepEqual(mergeQueryValues(auditFields, { review_status: 'approved' }, {}), { review_status: 'approved' });
assert.deepEqual(mergeQueryValues(auditFields, { review_status: 'approved' }, { review_status: 'all' }), { review_status: 'all' });
// 地址栏里的额外条件照样带上。
assert.deepEqual(mergeQueryValues(auditFields, {}, { reason: '改密码' }), { review_status: 'pending', reason: '改密码' });
// 没有默认值也没人给的字段不会凭空出现。
assert.deepEqual(mergeQueryValues([{ dataIndex: 'reason' }], {}, {}), {});

// —— 写进地址栏的只有「与默认值不同」的那几个 ——
// 都写的话，什么都没挑就跳成 ?q.review_status=all&q.data_status=all&q.scope=all，
// 三个参数说的都是「不筛选」。
const auditFilters = [{ dataIndex: 'review_status', defaultValue: 'all' }, { dataIndex: 'data_status', defaultValue: 'all' }, { dataIndex: 'reason' }];
assert.deepEqual(queryUrlValues(auditFilters, { review_status: 'all', data_status: 'all' }), {});
assert.deepEqual(queryUrlValues(auditFilters, { review_status: 'pending', data_status: 'all' }), { review_status: 'pending' });
// 没有默认值的字段：填了就写。
assert.deepEqual(queryUrlValues(auditFilters, { reason: '改密码' }), { reason: '改密码' });
assert.deepEqual(queryUrlValues(auditFilters, { reason: '' }), {});
// 认不出来的字段按「默认为空」处理，填了就写。
assert.deepEqual(queryUrlValues(auditFilters, { table_name: 'base_users' }), { table_name: 'base_users' });

// —— 地址栏 → 接口参数 ——
// 地址上什么都没写就不带任何参数，接口照常用它自己的默认值。
assert.deepEqual(tableRequestParams(''), {});
assert.deepEqual(tableRequestParams('?tab=profile'), {}, '页面自身的参数不往接口带');
// 这就是 /panel/admin/base/audit.html?q.review_status=all 首屏该发出的参数。
assert.deepEqual(tableRequestParams('?q.review_status=all'), { review_status: 'all' });
assert.deepEqual(tableRequestParams('?page=3&size=50'), { pageNum: '3', pageSize: '50' }, '地址用 page/size，接口用 pageNum/pageSize');
assert.deepEqual(tableRequestParams('?sort=status:asc,user_name:desc'), { sort: 'status:asc,user_name:desc' });
assert.deepEqual(tableRequestParams('?page=2&size=20&sort=id:desc&q.review_status=all&q.reason=改密码'), {
	pageNum: '2', pageSize: '20', sort: 'id:desc', review_status: 'all', reason: '改密码',
});
// 坏值不往接口带脏数据：读取时已经回落到合法值。
assert.deepEqual(tableRequestParams('?page=abc'), { pageNum: '1' });

console.log('table url state test passed');
