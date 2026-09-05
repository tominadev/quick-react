export type FormPageFieldType = 'text' | 'password' | 'switch' | 'select' | 'hidden' | 'change-control';

export type FormPageField = {
	name: string;
	label: string;
	type?: FormPageFieldType;
	extra?: string;
	placeholder?: string;
	maxLength?: number;
	checkedChildren?: string;
	unCheckedChildren?: string;
	options?: Array<{ value: string; text: string; fieldValues?: Record<string, unknown> }>;
	readOnlyWhen?: FieldReadOnlyWhen;
	/** 字段为空时“还原”使用的后端默认值。 */
	defaultValue?: unknown;
	rules?: { required?: boolean; message?: string }[];
	/** 仅 change-control 使用：要不要渲染「立即生效」勾选。 */
	allowImmediate?: boolean;
};

/**
 * 第三方登录入口：前端按 key 渲染图标链接，点击后走 `?action=provider:<key>`。
 * recommended 的入口排在最前并标注 hint，用于优先引导到体验更好的登录方式。
 */
export type FormPageExternalLogin = { key: string; label: string; recommended?: boolean; hint?: string };

/**
 * 一段独立的表单：自己的字段、自己的提交按钮。
 *
 * 用在「同一件事有两条互斥的路」的页面上——首次用 Accounts 登录本站时，要么用带过来的
 * 用户名建个新账号，要么把这个身份绑到已有账号上。两条路各要各的字段（绑定还要密码），
 * 也各要各的按钮，塞进一个表单会让「必填」互相牵连：填了建号那半，绑定那半的密码也会被要求。
 *
 * 提交时只发本段的字段，外加 `_section` 标明走的是哪条路。
 */
export type FormPageSection = {
	key: string;
	/** 选项卡上的标题；sectionLayout 为 tabs 时必填。 */
	title?: string;
	/** 段前分隔线上的文字；stacked 布局用，第一段通常不需要。 */
	divider?: string;
	description?: string;
	fields: FormPageField[];
	submitLabel: string;
	/** 提交按钮正上方的一句说明，用来讲清「按下去会发生什么」。 */
	submitHint?: string;
};

export const SECTION_FIELD = '_section';

export type FormPageConfig = {
	/** 分段表单；给出这个就不渲染 fields/submitLabel 那套单表单。 */
	sections?: FormPageSection[];
	/**
	 * 分段怎么排。
	 * - `stacked`（默认）：上下堆叠，段间用分隔线。适合「两条互斥的路」，两条都要看得见。
	 * - `tabs`：选项卡。适合「同一个对象的几组互不相干的设置」，一次只关心一组。
	 */
	sectionLayout?: 'stacked' | 'tabs';
	/** 这个页面要不要收集「变更说明」；由服务端按请求路径注入，登录与注册页不需要。 */
	changeControl?: boolean;
	/** 当前用户能不能跳过审批；由服务端在 apiResponse 里统一注入，见 TableOption.canSkipApproval。 */
	canSkipApproval?: boolean;
	/** 需要前往 Accounts 完成登录的页面：只在用户点击后弹出登录窗口，本页既不自动跳转也不整页跳走。 */
	passportLogin?: { enabled: boolean };
	description?: string;
	submitLabel?: string;
	actions?: Array<{ key: string; label: string; confirm?: string }>;
	/** 页面级默认值；配合 restore-defaults 动作重置当前表单，保存后才写入配置。 */
	defaultValues?: Record<string, unknown>;
	externalLogins?: FormPageExternalLogin[];
	confirmOnUnchangedSubmit?: string;
	submitHint?: string;
	initialValues: Record<string, unknown>;
	fields?: FormPageField[];
};

export type FormPageResponse<T = Record<string, unknown>> = {
	currentValues?: T;
	formPage?: FormPageConfig;
	feedback?: ApiFeedback;
	next?: ApiNextAction;
	context?: ApiContext;
	redirectTo?: string;
	/** 在弹窗里完成的流程：优先关闭窗口，关不掉时才回落到 redirectTo。 */
	closeWindow?: boolean;
	/** 在当前页面打开外部授权弹窗，表单本身保持打开。 */
	openWindow?: boolean;
};
import type { ApiContext, ApiFeedback, ApiNextAction } from './api-response.mjs';
import type { FieldReadOnlyWhen } from '../field-linkage.mjs';

/**
 * 客户端注入的**变更说明**字段：操作原因与「立即生效」合成一个控件，
 * 与 TableCRUD 的 changeControlColumn 同源。默认不勾，即默认走审批。
 */
export const changeControlField = (allowImmediate: boolean): FormPageField => ({
	name: '_change',
	label: '变更说明',
	type: 'change-control',
	allowImmediate,
	placeholder: '操作原因（可留空）；写清为什么改，事后追查时最有用',
});
