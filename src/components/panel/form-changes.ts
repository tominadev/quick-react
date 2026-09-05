import type { FormPageField } from '@shared/types/form-page.mjs';
import { isSystemField } from '@shared/system-fields.mjs';

/** 值按人读的方式显示：开关说「开/关」，下拉说选项文案而不是它的值，空值说「空」。 */
export const readableFieldValue = (field: FormPageField | undefined, value: unknown) => {
	if (field?.type === 'switch' || typeof value === 'boolean') return value ? '开' : '关';
	if (value === undefined || value === null || value === '') return '空';
	const option = field?.options?.find((item) => item.value === String(value));
	if (option) return option.text;
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

/**
 * 协议字段一律下划线开头：`_change`、`_pending`、`_row_key`、`_section`、`__changedFields`。
 *
 * 它们跟着表单值一起提交，但不是这条记录的字段。不排掉的话，什么都没改点保存会弹出
 * 「将保存以下修改：__changedFields：空 → []」——那是把协议本身念给用户听，而且因为
 * 清单不为空，连「当前未修改，仍要提交吗？」那句正确的提示都被顶掉了。
 *
 * 按前缀排而不是逐个列名单：新加一个协议字段时不必回来改这里，漏改的表现正是上面那句。
 */
const isProtocolField = (name: string) => name.startsWith('_');

/**
 * 保存前列给人看的改动清单。
 *
 * 判据是「**显示出来真的不一样**」，而不是「这个字段被标记过」：「还原默认」会把每个
 * 字段都标记成已改，不管值有没有真的变；用户打一个字又删掉也会留下标记。照标记列的话，
 * 确认框里全是「8088 → 8088」这种自说自话的行。
 *
 * 清单为空就等于没改，调用方据此改问「当前未修改，仍要提交吗？」。
 */
export const describeFormChanges = (
	fields: readonly FormPageField[] | undefined,
	changed: Iterable<string>,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	ignore: readonly string[] = [],
) => [...changed]
	.filter((name) => !ignore.includes(name) && !isSystemField(name) && !isProtocolField(name))
	.flatMap((name) => {
		const field = fields?.find((item) => item.name === name);
		const from = readableFieldValue(field, before[name]);
		const to = readableFieldValue(field, after[name]);
		return from === to ? [] : [`${field?.label || name}：${from} → ${to}`];
	});
