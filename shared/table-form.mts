import type { TableColumn } from './types/table.mjs';
import { isSystemField } from './system-fields.mjs';

export type TableFormMode = 'create' | 'edit';

export const resolveTableFormColumns = (columns: TableColumn[], mode: TableFormMode): TableColumn[] => columns.flatMap((definition) => {
	if (isSystemField(definition.dataIndex)) return [];
	const { form, ...column } = definition;
	const override = form?.[mode];
	if (override === false) return [];
	return [{ ...column, ...override }];
});

/**
 * 客户端注入的**变更控制**字段：操作原因与「立即生效」合成一个控件。
 *
 * 合在一起而不是两个表单项：它们是同一件事的两半——「为什么改」和「现在改还是等人批」，
 * 拆成两行会让人以为是两个不相关的选项。确认框里本来就是并排渲染的，这样两条路径一致。
 *
 * 提交前从请求体里摘出去、改走请求头，业务路由永远看不见它。
 */
export const CHANGE_CONTROL_FIELD = '_change';
export type ChangeControlValue = { reason?: string; immediate?: boolean };
export const changeControlColumn = (allowImmediate: boolean): TableColumn => ({
	dataIndex: CHANGE_CONTROL_FIELD,
	title: '变更说明',
	component: 'change-control',
	allowImmediate,
	placeholder: '操作原因（可留空）；写清为什么改，事后追查时最有用',
});

/** 从合并字段里取出请求头。头部只能放 ASCII，因此原因先 encodeURIComponent。 */
export const changeControlHeaders = (value: unknown, allowImmediate: boolean): Record<string, string> => {
	const control = (value ?? {}) as ChangeControlValue;
	const reason = typeof control.reason === 'string' ? control.reason.trim().slice(0, 500) : '';
	return {
		...(reason ? { 'X-Change-Reason': encodeURIComponent(reason) } : {}),
		...(allowImmediate && control.immediate ? { 'X-Change-Immediate': '1' } : {}),
	};
};
