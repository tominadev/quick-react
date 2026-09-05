export type FormPageFieldType = 'text' | 'password' | 'switch' | 'select' | 'hidden';

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

/**
 * 置顶提示块：一个显眼的框，自带标题、逐条内容和自己的按钮。
 *
 * 与 `description` 的区别在于「要不要人现在就处理」：description 是这个页面是干什么的，
 * 提示块是**这里有件事在等你**。因此按钮跟内容放在一起——「有 3 项修改在等审批」和
 * 「批准 / 驳回」隔着半屏，人得先看懂上面那句再去下面找按钮。
 */
export type FormPageNotice = {
	type?: 'info' | 'warning' | 'error';
	title: string;
	/** 一条一行，例如逐项列出待审批的改动。 */
	lines?: string[];
	actions?: Array<{ key: string; label: string; confirm?: string; danger?: boolean }>;
};

export type FormPageConfig = {
	/** 置顶提示块，排在描述之前。 */
	notice?: FormPageNotice;
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
	/** 需要前往 Accounts 完成登录的页面：只在用户点击后弹出登录窗口，本页既不自动跳转也不整页跳走。 */
	passportLogin?: { enabled: boolean };
	description?: string;
	submitLabel?: string;
	actions?: Array<{ key: string; label: string; confirm?: string }>;
	/** 页面级默认值；配合 restore-defaults 动作重置当前表单，保存后才写入配置。 */
	defaultValues?: Record<string, unknown>;
	externalLogins?: FormPageExternalLogin[];
	confirmOnUnchangedSubmit?: string;
	/**
	 * 提交前把**改了哪几项、从什么变成什么**列出来让人确认。
	 *
	 * 设置类页面一屏十几个开关，改完隔一会儿再回来点保存，多半已经记不清动过哪些；
	 * 而这些改动往往立刻影响整个站点的行为（关掉本站登录、改掉页脚、切换启动模式）。
	 * 值为确认框的标题。
	 */
	confirmChangedSubmit?: string;
	submitHint?: string;
	initialValues: Record<string, unknown>;
	fields?: FormPageField[];
};

export type FormPageResponse<T = Record<string, unknown>> = {
	currentValues?: T;
	formPage?: FormPageConfig;
	feedback?: ApiFeedback;
	next?: ApiNextAction;
	context?: ApiContext | ApiContextPatch;
	redirectTo?: string;
	/** 在弹窗里完成的流程：优先关闭窗口，关不掉时才回落到 redirectTo。 */
	closeWindow?: boolean;
	/** 在当前页面打开外部授权弹窗，表单本身保持打开。 */
	openWindow?: boolean;
};
import type { ApiContext, ApiContextPatch, ApiFeedback, ApiNextAction } from './api-response.mjs';
import type { FieldReadOnlyWhen } from '../field-linkage.mjs';
