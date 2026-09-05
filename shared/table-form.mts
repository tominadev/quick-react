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
/** 撤销自己的申请不问原因；与服务端 pending-approval 里的动作名保持一致。 */
export const WITHDRAW_ACTION = 'withdraw-pending';
export type ChangeControlValue = { reason?: string };

/**
 * 从确认框收到的值取出请求头。头部只能放 ASCII，因此原因先 encodeURIComponent。
 *
 * 只剩「操作原因」一项：「立即生效」那个勾选框已废除——管理后台的修改一律进审批队列，
 * 有权限的人在待审批提示里点「批准并生效」。两条路做同一件事，留一条就够。
 */
export const changeControlHeaders = (value: unknown): Record<string, string> => {
	const control = (value ?? {}) as ChangeControlValue;
	const reason = typeof control.reason === 'string' ? control.reason.trim().slice(0, 500) : '';
	return reason ? { 'X-Change-Reason': encodeURIComponent(reason) } : {};
};
