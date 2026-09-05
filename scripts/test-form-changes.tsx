import assert from 'node:assert/strict';
import { describeFormChanges, readableFieldValue } from '@/components/panel/form-changes.js';

const fields = [
	{ name: 'port', label: 'HTTP 端口' },
	{ name: 'debug', label: '调试模式', type: 'switch' as const },
	{ name: 'mode', label: '页面启动模式', options: [{ value: 'server', text: '服务端注入' }, { value: 'api', text: '仅输出页面壳' }] },
	{ name: 'origin', label: '公共 Origin' },
];

// —— 值怎么显示给人看 ——
assert.equal(readableFieldValue(fields[1], true), '开');
assert.equal(readableFieldValue(fields[1], false), '关');
assert.equal(readableFieldValue(fields[2], 'api'), '仅输出页面壳', '下拉说选项文案，不说它的值');
assert.equal(readableFieldValue(fields[3], ''), '空');
assert.equal(readableFieldValue(fields[3], undefined), '空');
assert.equal(readableFieldValue(fields[0], 8088), '8088');
assert.equal(readableFieldValue(undefined, { a: 1 }), '{"a":1}');

// —— 真改了才列 ——
assert.deepEqual(
	describeFormChanges(fields, ['port'], { port: 8088 }, { port: 9000 }),
	['HTTP 端口：8088 → 9000'],
);
assert.deepEqual(
	describeFormChanges(fields, ['debug', 'mode'], { debug: false, mode: 'server' }, { debug: true, mode: 'api' }),
	['调试模式：关 → 开', '页面启动模式：服务端注入 → 仅输出页面壳'],
);

// 「还原默认」会把每个字段都标记成已改，不管值有没有真的变；照标记列的话，
// 确认框里全是「8088 → 8088」这种自说自话的行。
assert.deepEqual(
	describeFormChanges(fields, ['port', 'debug', 'mode', 'origin'], { port: 8088, debug: false, mode: 'server', origin: '' }, { port: 8088, debug: false, mode: 'server', origin: '' }),
	[],
	'值没变就一行都不列',
);
// 只有真变的那一项进清单，其余标记过的字段不出现。
assert.deepEqual(
	describeFormChanges(fields, ['port', 'debug'], { port: 8088, debug: false }, { port: 8088, debug: true }),
	['调试模式：关 → 开'],
);
// 打了字又删掉：显示上没差别，不该占一行。
assert.deepEqual(describeFormChanges(fields, ['origin'], { origin: '' }, { origin: undefined }), []);
assert.deepEqual(describeFormChanges(fields, ['origin'], { origin: undefined }, { origin: '' }), []);

// —— 该排除的 ——
assert.deepEqual(describeFormChanges(fields, ['port', '_change'], { port: 1 }, { port: 2 }, ['_change']), ['HTTP 端口：1 → 2']);
// 协议字段按前缀排掉，调用方不必逐个传进 ignore——TableCRUD 的编辑抽屉就没传，
// 于是什么都没改点保存会弹出「__changedFields：空 → []」，还把「当前未修改」那句顶掉了。
assert.deepEqual(describeFormChanges(fields, ['__changedFields'], {}, { __changedFields: [] }), [], '__changedFields 不是这条记录的字段');
assert.deepEqual(describeFormChanges(fields, ['_change', '_pending', '_row_key', '_section'], {}, { _change: { reason: 'x' }, _pending: '1', _row_key: 'a', _section: 's' }), [], '协议字段一个都不列');
assert.deepEqual(describeFormChanges(fields, ['port', '__changedFields'], { port: 1 }, { port: 2, __changedFields: ['port'] }), ['HTTP 端口：1 → 2'], '业务字段照列');
assert.deepEqual(describeFormChanges(fields, ['created_at'], { created_at: 1 }, { created_at: 2 }), [], '系统字段不列');
// 没有登记的字段用字段名兜底，而不是整行消失。
assert.deepEqual(describeFormChanges(fields, ['unknown'], { unknown: 'a' }, { unknown: 'b' }), ['unknown：a → b']);

console.log('form changes test passed');
