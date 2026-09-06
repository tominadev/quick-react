export type TableData = Record<string, unknown>;
export type TableColumnComponent = 'textbox' | 'url' | 'avatar' | 'avatar_text' | 'textarea' | 'select' | 'switch' | 'datepicker' | 'datepicker_rangepicker' | 'inputnumber' | 'upload';
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
	 * 用于同一张表上互斥的动作——例如审计里「回滚」只对已生效的行有意义，
	 * 「重新应用」只对已回滚的行有意义，一行上永远只该出现其中一个。
	 */
	visibleWhen?: { field: string; values: string[] };
	form?: {
		columns: TableColumn[];
	};
	/**
	 * 点这个动作时，把该行的这几个字段原样发回请求体。
	 *
	 * 由服务端声明，前端不按 key 名去猜——猜的话每加一个这样的动作都要回来改前端。
	 * 审批那三个动作用它把「页面上看到的是哪几条申请」带回去。
	 */
	sendFields?: string[];
	/** 在当前列表内打开后端驱动的表单弹窗。工具栏与行上都支持。 */
	modalPath?: string;
	/**
	 * 行上的弹窗要带哪几个查询条件：`{查询字段: 本行的哪一列}`。
	 *
	 * 由服务端声明，前端不按字段名去猜。审批页的「处理经过」用它把 `approval_id=本行 id`
	 * 带进去——弹窗里那张表是全站的事件列表，不筛的话打开就是别人的记录。
	 */
	modalQueryFields?: Record<string, string>;
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
};
/**
 * 表格行的合成主键字段。
 *
 * 只有**没有主键的只读表**才需要它——有主键的表直接把 `option.rowKey` 声明成那一列。
 * 早先一律合成一个叫 `key` 的字段，而 `base_configs`、`global_sites` 这些表自己就有
 * `key` 列，`{ ...row, key: 主键值 }` 把真值覆盖成了 id：列表上看着像「key 存成数字了」。
 * 下划线前缀表示协议保留字段，与 `_pending`、`_section` 一致，撞不上任何业务列。
 */
export const ROW_KEY_FIELD = '_row_key';

/**
 * 这一行有没有修改在等审批。`'1'` 是有，空串是没有。
 *
 * 是**数据不是列**：表格不为它开一列（一整列只为极少数几行显示标签，其余全空），
 * 前端拿它给那几行换底色，服务端的 `visibleWhen` 也拿它决定撤销/批准两个动作显不显示。
 * 因此它必须两边共用一个名字，写在这里。
 */
export const PENDING_FIELD = '_pending';

/**
 * 这一行上待审批记录的 id，逗号分隔。
 *
 * 撤销/批准/驳回三个动作把它原样发回服务端，**动的就是页面上看到的那几条**。只发行号的话，
 * 服务端要在收到请求时重新解一遍「这一行有哪些待审批」——中间别人又提了一条，点下去就
 * 连它一起处理了，而那一条操作者根本没看见。
 */
export const PENDING_IDS_FIELD = '_pending_ids';

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
