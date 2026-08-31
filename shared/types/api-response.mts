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

/** 后端响应层按 include=auth 返回的当前页面上下文。 */
export type ApiContext = {
	auth?: AuthState;
	siteNavigation?: NavigationItem[];
	pageStatus?: PageStatus;
};

export type ApiResponseBody = {
	message?: string;
	feedback?: ApiFeedback;
	next?: ApiNextAction;
	context?: ApiContext;
	table?: import('./table.mjs').TableResponse;
};
