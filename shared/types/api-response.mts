import type { NavigationItem } from './navigation.mjs';
import type { AuthState, PageStatus } from './initial-data.mjs';

export type ApiFeedbackComponent = 'inline' | 'message' | 'modal' | 'none';
export type ApiFeedbackType = 'success' | 'info' | 'warning' | 'error';

export type ApiFeedback = {
	component?: ApiFeedbackComponent;
	type?: ApiFeedbackType;
	showIcon?: boolean;
	title?: string;
	message?: string;
	refreshNowLabel?: string;
	cancelRefreshLabel?: string;
	redirectAfter?: number;
};

export type ApiFeedbackOptions = Partial<Omit<ApiFeedback, 'message'>>;
export type ApiSuccessData = Record<string, unknown> & { message?: never };

/** 后端下发的通用完成动作；前端组件只负责执行，不自行决定操作完成后的去向。 */
export type ApiNextAction =
	| { action: 'reload'; delay?: number }
	/** `refreshAuth` 表示先应用响应中附带的认证上下文，再由浏览器路由切换路径。 */
	| { action: 'navigate'; path: string; refreshAuth?: boolean };

/** 后端响应层按 include=auth 返回的当前页面上下文，表格资源按 include=schema,data 精确选择。 */
export type ApiContext = {
	auth?: AuthState;
	siteNavigation?: NavigationItem[];
	pageStatus?: PageStatus;
};

/**
 * 局部上下文：只带变化的那几个字段，客户端按路径**合并**而不是整份替换。
 *
 * 改个昵称而已，导航树、页面状态、可用动作一样都没变，整份 ApiContext 传一遍既浪费，
 * 又容易把没变的东西覆盖成空。路径与完整上下文保持一致，客户端因此不必分两套处理。
 */
export type ApiContextPatch = { auth?: { currentUser?: Partial<import('./user.mjs').UserIdentity> } };

export type ApiResponseBody = {
	message?: string;
	feedback?: ApiFeedback;
	next?: ApiNextAction;
	context?: ApiContext | ApiContextPatch;
	/** 页面启动响应中的业务数据；由对应通用组件直接消费。 */
	home?: import('./home.mjs').HomePageData;
	dashboard?: import('./dashboard.mjs').DashboardData;
	formPage?: import('./form-page.mjs').FormPageConfig;
	currentValues?: Record<string, unknown>;
	user?: import('./user.mjs').UserIdentity | null;
	accountsNotice?: string;
	accountsCenter?: import('./user.mjs').AccountCenterLink;
	table?: import('./table.mjs').TableResponse;
};
