import type { FormPageField } from '@shared/types/form-page.mjs';
import { isSystemField } from '@shared/system-fields.mjs';

/**
 * 提交前摆给人看的那份「将要改什么」。
 *
 * 和 `table-crud.ts` 一样放在 `clients/browser`：这里没有任何渲染，只是把字段值念成
 * 人话、把前后两份值比成几行文字。**确认框里念出来的内容属于变更审计的一部分**——
 * 审批人事后读到的就是这几行，两套 UI 各写一遍的话，同一次改动在手机上和电脑上会被
 * 描述成不同的样子，而那种漂移没有任何人会去核对。
 */

/** 值按人读的方式显示：开关说「开/关」，下拉说选项文案而不是它的值，空值说「空」。 */
export const readableFieldValue = (field: FormPageField | undefined, value: unknown) => {
	if (field?.type === 'switch' || typeof value === 'boolean') return value ? '开' : '关';
	/**
	 * 三种「没有值」要分清两件事：
	 *
	 * - `null` 是**人选的**（点 ✕ 存 NULL），念「未填写」——都念作「空」就把他刚做的选择抹掉了。
	 * - `undefined` 是**没提到这个字段**（对象里根本没这个键），与空串一样什么也没说，念「空」。
	 *   混进「未填写」的话，「打了字又删掉」会被显示成一次改动。
	 */
	if (value === null) return '未填写';
	if (value === undefined || value === '') return '空';
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

/**
 * 新增前列给人看的内容清单。
 *
 * 与「改了什么」分开写，不是把 before 当成空跑一遍 describeFormChanges：新增没有前值，
 * 「用户名：空 → newguy」比「用户名：newguy」多了一个箭头和一个「空」，却什么也没多说。
 *
 * **没填的不列**：新建表单动辄十几格，把空的也摆出来会把真正填了的那几行淹掉。
 * **密码一类不回显**：把刚输入的口令原样念一遍，确认框本身就成了泄漏点。
 */
export const describeFormAdditions = (
	fields: readonly FormPageField[] | undefined,
	values: Record<string, unknown>,
) => Object.entries(values)
	.filter(([name]) => !isSystemField(name) && !isProtocolField(name))
	.flatMap(([name, value]) => {
		const field = fields?.find((item) => item.name === name);
		const label = field?.label || name;
		if (field?.type === 'password') return value ? [`${label}：已填写`] : [];
		const text = readableFieldValue(field, value);
		return text === '空' ? [] : [`${label}：${text}`];
	});

/**
 * 这一格现在是不是有东西可清。
 *
 * 「清空」按钮的门禁：空格子上摆一个清空按钮，点下去什么也不会发生。登录、注册这类
 * 表单每一格都是空的，整排按钮全是噪音。
 *
 * `false` 算没有内容，是给开关留的——开关不提供清空（关掉就是它的空），值为 `false`
 * 时按钮不该冒出来。
 *
 * 判据要对着**当前值**问，不是对着初始值：用户刚敲进去还没保存的内容同样清得掉。
 */
export const fieldHasValue = (value: unknown) => value !== undefined && value !== null && value !== '' && value !== false;
