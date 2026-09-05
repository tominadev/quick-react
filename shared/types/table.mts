export type TableData = Record<string, unknown>;
export type TableColumnComponent = 'textbox' | 'url' | 'avatar' | 'avatar_text' | 'textarea' | 'select' | 'switch' | 'datepicker' | 'datepicker_rangepicker' | 'inputnumber' | 'upload' | 'change-control';
export type TableDataType = 'js_timestamp' | 'int' | 'float' | 'string' | 'datetime';
export type TableColumnRule = { required: boolean; message: string };
export type TableColumnRemoteOptions = { action: string; dependencies: string[]; clearFields?: string[] };
export type TableColumnFormProperties = {
	component?: TableColumnComponent;
	inputType?: 'text' | 'password';
	rules?: TableColumnRule[];
	placeholder?: string;
	options?: TableSelectOption[];
	dependsOn?: string;
	parentValues?: Array<string | number | boolean>;
	multiple?: boolean;
	allowCustomValue?: boolean;
	readOnlyWhen?: FieldReadOnlyWhen;
	remoteOptions?: TableColumnRemoteOptions;
	checkedValue?: string | boolean;
	uncheckedValue?: string | boolean;
	dataType?: TableDataType;
	/** 仅 change-control 组件使用：要不要渲染「立即生效」勾选。 */
	allowImmediate?: boolean;
	/**
	 * 表单里的分组名。任一列带上它，编辑抽屉就按分组渲染成可切换的 Tab；
	 * 没带的列归到第一个分组。只影响表单，不影响列表。
	 */
	group?: string;
	dayjsFormat?: string;
};
export type TableColumnFormOverride = TableColumnFormProperties & { title?: string };
export type TableColumnFormModes = {
	create?: TableColumnFormOverride | false;
	edit?: TableColumnFormOverride | false;
};
export type TableAction = {
	key: string;
	label: string;
	disabled?: boolean;
	confirm?: string;
	/**
	 * 工具栏动作作用于**选中的行**：点击时把选中行的主键放在请求体里发过去。
	 *
	 * 由服务端声明，前端不按 key 名去猜——猜的话每加一个批量动作都要回来改前端，
	 * 漏改的表现是「明明选了行却提示请先选择记录」。
	 */
	selection?: boolean;
	/**
	 * 按行决定这个动作显不显示：只有当该行 `field` 列的值落在 `values` 里才渲染。
	 * 用于同一张表上互斥的动作——例如审计里「撤回」只对已生效的行有意义，
	 * 「恢复」只对已撤回的行有意义，一行上永远只该出现其中一个。
	 */
	visibleWhen?: { field: string; values: string[] };
	form?: {
		columns: TableColumn[];
	};
	/** 在当前列表内打开后端驱动的表单弹窗。 */
	modalPath?: string;
	/** 弹窗内容类型；未指定时默认为表单。 */
	modalComponent?: 'form' | 'table';
};
export type TableQueryField = {
	dataIndex: string;
	label: string;
	component: 'textbox' | 'select';
	placeholder?: string;
	defaultValue?: string;
	options?: TableSelectOption[];
	/** 查询值变化后页面结构也会变化，下一次请求必须重新返回 option/columns。 */
	reloadSchema?: boolean;
};
export type TableColumn = TableColumnFormProperties & {
	dataIndex: string;
	title: string;
	ellipsis?: boolean;
	hideInTable?: boolean;
	/** 这一列能不能排序；由服务端按它是否真的可排序下发，前端不自行推断。 */
	sortable?: boolean;
	tableDisplay?: 'multiline' | 'reference';
	tableDisplayTextField?: string;
	form?: TableColumnFormModes;
};
export type TableActions = { toolbar?: TableAction[]; query?: TableAction[]; row?: TableAction[] };
export type TableOption = {
	rowKey: string;
	actions?: TableActions;
	queryFields?: TableQueryField[];
	/** 这个页面要不要收集「变更说明」；由服务端按请求路径注入，登录与注册页不需要。 */
	changeControl?: boolean;
	/**
	 * 当前用户能不能跳过审批。由服务端在 apiResponse 里统一注入，前端据此决定
	 * 渲不渲染「立即生效」勾选框；放行与否服务端另有一道校验，不看这个字段。
	 */
	canSkipApproval?: boolean;
};
export type TableSelectOption = {
	value: string;
	text: string;
	color?: string;
	dataTypes?: string[];
	parentValue?: string;
	fieldValues?: Record<string, string | number | boolean>;
};
/** 表格请求必须用 include 明确选择资源；`include=data` 只返回数据，`include=schema,data` 返回完整响应。 */
export type TableResponse = {
	option?: TableOption;
	columns?: TableColumn[];
	dataSource?: TableData[];
	totalRecords?: number;
	nextCursor?: string;
	hasMore?: boolean;
};
export type TableRow = TableData & { key: string };
import type { FieldReadOnlyWhen } from '../field-linkage.mjs';
