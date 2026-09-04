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

export type FormPageConfig = {
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
	fields: FormPageField[];
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
