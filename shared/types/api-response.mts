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
	/** `refreshAuth` 表示先让应用重新读取后端认证状态，再由浏览器路由切换路径。 */
	| { action: 'navigate'; path: string; refreshAuth?: boolean };

export type ApiResponseBody = {
	message?: string;
	feedback?: ApiFeedback;
	next?: ApiNextAction;
	table?: import('./table.mjs').TableResponse;
};
