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
 * 客户端注入的「操作原因」表单字段。
 *
 * 它不是业务字段：提交前会从请求体里摘出去、改走 X-Change-Reason 请求头，
 * 因此业务路由永远看不见它，也不会误把它当成一列数据。
 */
export const CHANGE_REASON_FIELD = '_reason';
export const changeReasonColumn = (): TableColumn => ({
	dataIndex: CHANGE_REASON_FIELD,
	title: '操作原因',
	component: 'textbox',
	placeholder: '可留空；写清为什么改，事后追查时最有用',
});

/**
 * 「立即生效」勾选：跳过审批直接写库。
 *
 * **默认不勾——默认走审批。** 只对管理员渲染；服务端另有一道角色校验，
 * 非管理员伪造这个字段也照样进审批队列（见需求文档 §11.3）。
 */
export const CHANGE_IMMEDIATE_FIELD = '_immediate';
export const changeImmediateColumn = (): TableColumn => ({
	dataIndex: CHANGE_IMMEDIATE_FIELD,
	title: '立即生效',
	component: 'switch',
	checkedValue: '1',
	uncheckedValue: '',
	placeholder: '跳过审批直接生效；不勾则提交审批',
});
