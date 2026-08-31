import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './types.mjs';
import type { ApiFeedback, ApiFeedbackOptions, ApiSuccessData } from '@shared/types/api-response.mjs';
import { createDeviceKeyTransportCookie } from './device-fingerprint.mjs';
import { isSecureRequest } from './request-origin.mjs';
export type { ApiFeedback, ApiFeedbackOptions, ApiSuccessData } from '@shared/types/api-response.mjs';

const isSuccessStatus = (status: number) => status >= 200 && status < 300;
const requestsAuthContext = (c: Context<AppEnv>) => (c.req.query('include') ?? '').split(',').map((value) => value.trim()).includes('auth');
const requestsTableDataOnly = (c: Context<AppEnv>) => ['0', 'false'].includes((c.req.query('table_schema') ?? '').trim().toLowerCase());

/** 所有 TableCRUD 统一提供回收站入口；具体回收、恢复和彻底删除动作仍由原接口驱动。 */
const withTableUtilities = (c: Context<AppEnv>, payload: Record<string, unknown>) => {
	if (!c.get('tableCrud')) return payload;
	const table = payload.table;
	if (!table || typeof table !== 'object' || Array.isArray(table)) return payload;
	const source = table as Record<string, unknown>;
	const option = source.option;
	if (!option || typeof option !== 'object' || Array.isArray(option)) return payload;
	const optionSource = option as Record<string, unknown>;
	const actions = optionSource.actions && typeof optionSource.actions === 'object' && !Array.isArray(optionSource.actions)
		? optionSource.actions as Record<string, unknown>
		: {};
	const deleted = c.req.query('deleted') === 'deleted';
	if (deleted) {
		return {
			...payload,
			table: {
				...source,
				option: {
					...optionSource,
					actions: {
						...actions,
						toolbar: [
							{ key: 'restore', label: '恢复选中记录', confirm: '确认恢复选中的记录吗？' },
							{ key: 'purge', label: '彻底删除选中记录', confirm: '彻底删除后无法恢复，确认继续吗？' },
						],
						row: [
							{ key: 'restore', label: '恢复', confirm: '确认恢复这条记录吗？' },
							{ key: 'purge', label: '彻底删除', confirm: '彻底删除后无法恢复，确认继续吗？' },
						],
					},
				},
			},
		};
	}
	const toolbar = Array.isArray(actions.toolbar) ? actions.toolbar : [];
	if (toolbar.some((action) => action && typeof action === 'object' && (action as Record<string, unknown>).key === 'recycle-bin')) return payload;
	const apiPath = c.req.path.startsWith('/api') ? c.req.path.slice('/api'.length) : c.req.path;
	const apiSuffix = c.get('techStackConfig').apiSuffix;
	const modalPath = apiSuffix && apiPath.endsWith(apiSuffix) ? apiPath.slice(0, -apiSuffix.length) : apiPath;
	return {
		...payload,
		table: {
			...source,
			option: {
				...optionSource,
				actions: {
					...actions,
					toolbar: [...toolbar, { key: 'recycle-bin', label: '回收站', modalPath, modalComponent: 'table' }],
				},
			},
		},
	};
};

const stripTableSchema = (payload: Record<string, unknown>) => {
	const table = payload.table;
	if (!table || typeof table !== 'object' || Array.isArray(table)) return payload;
	const source = table as Record<string, unknown>;
	const dataOnly = Object.fromEntries(['dataSource', 'totalRecords', 'nextCursor', 'hasMore']
		.filter((key) => key in source)
		.map((key) => [key, source[key]]));
	return { ...payload, table: dataOnly };
};

const defaultMessage = (status: number) => {
	if (status === 200) return '操作成功';
	if (status === 201) return '创建成功';
	if (status === 202) return '请求已接受';
	if (status === 204) return '操作成功';
	if (status === 400) return '请求参数错误';
	if (status === 401) return '请先登录';
	if (status === 403) return '无权执行此操作';
	if (status === 404) return '请求的资源不存在';
	if (status === 409) return '请求冲突';
	if (status === 422) return '数据校验失败';
	if (status === 429) return '请求过于频繁';
	if (status >= 200 && status < 300) return '操作成功';
	if (status >= 400 && status < 500) return '请求失败';
	return '服务器错误';
};

const writeApiResponse = (c: Context<AppEnv>, status: number, data: Record<string, unknown>) => (
	c.json(data, status as ContentfulStatusCode)
);

export const apiResponse = async <T extends ApiSuccessData>(
	c: Context<AppEnv>,
	status: number,
	data: T,
): Promise<Response> => {
	const payload = data as Record<string, unknown>;
	const next = payload.next;
	const refreshesAuth = Boolean(next && typeof next === 'object' && !Array.isArray(next) && (next as { refreshAuth?: unknown }).refreshAuth === true);
	const includesAuth = requestsAuthContext(c);
	const utilityPayload = withTableUtilities(c, payload);
	let responseData: Record<string, unknown> = requestsTableDataOnly(c) ? stripTableSchema(utilityPayload) : utilityPayload;
	const contextProvider = c.get('apiContext');
	if ((includesAuth || refreshesAuth) && contextProvider) {
		responseData = { ...responseData, context: await contextProvider(c.req.query('path')) };
		// 认证上下文包含当前用户，不得由浏览器或 CDN 缓存。
		c.header('Cache-Control', 'no-store');
	}
	const responseCookies = () => c.res.headers.get('set-cookie') ?? '';
	const deviceKey = c.req.header('x-device-key')?.trim();
	const transportCookie = deviceKey ? createDeviceKeyTransportCookie(deviceKey, isSecureRequest(c)) : '';
	if (transportCookie && !responseCookies().includes('device_key=')) c.header('Set-Cookie', transportCookie, { append: true });
	return c.json(responseData, status as ContentfulStatusCode);
};

/** API 启动请求需要先拿到认证上下文；权限守卫拒绝页面数据时仍返回该上下文，避免前端再发一次状态请求。 */
export const apiAuthContextFallback = (
	c: Context<AppEnv>,
	status: number,
	message: string,
) => requestsAuthContext(c) ? apiResponse(c, 200, {}) : apiMessage(c, status, message);

const messagePayload = (
	status: number,
	message: string,
	feedbackOptions: ApiFeedbackOptions,
	data: Record<string, unknown>,
) => isSuccessStatus(status)
	? {
		...data,
		feedback: {
			component: 'message' as const,
			type: 'success' as const,
			message,
			...feedbackOptions,
		},
	}
	: {
		feedback: {
			component: 'modal' as const,
			type: 'error' as const,
			message,
			...feedbackOptions,
		},
	};

export const apiMessage = (
	c: Context<AppEnv>,
	status: number,
	message?: string,
	feedbackOptions: ApiFeedbackOptions = {},
	data: Record<string, unknown> = {},
) => {
	const payload = messagePayload(status, message ?? defaultMessage(status), feedbackOptions, data);
	return isSuccessStatus(status)
		? apiResponse(c, status, payload as ApiSuccessData)
		: writeApiResponse(c, status, payload);
};

export const apiMessageData = (
	c: Context<AppEnv>,
	status: number,
	message: string,
	data: Record<string, unknown>,
	feedbackOptions: ApiFeedbackOptions = {},
) => {
	const payload = messagePayload(status, message, feedbackOptions, data);
	return isSuccessStatus(status)
		? apiResponse(c, status, payload as ApiSuccessData)
		: writeApiResponse(c, status, payload);
};
