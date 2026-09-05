import type { Context } from 'hono';
import type { AppEnv } from './types.mjs';
import type { ApiHandler } from './api-router.mjs';
import { apiMessage, apiMessageData, apiResponse, type ApiFeedbackOptions } from './api-response.mjs';
import { configRowId, handlePendingApprovalAction, pendingApprovalNotice } from './pending-approval.mjs';
import { PendingApprovalError } from './operation.mjs';
import type { FormPageConfig } from '@shared/types/form-page.mjs';

type Ctx = Context<AppEnv>;

/**
 * 一个「设置页」需要各自说明的部分。
 *
 * 除此之外的流程——读当前值、拼表单、待审批提示、撤销/批准/驳回、保存被拦进审批队列——
 * 每一页都一模一样，全部由 {@link settingsPageHandler} 统一实现。之前只有站点设置接了
 * 审批提示，另外三页各写各的保存分支，于是「改了什么在等审批」只在其中一页看得见。
 */
export type SettingsPage<T> = {
	/** base_configs 里的键；同时用来定位待审批的是哪一行。 */
	key: string;
	/**
	 * 从配置库读当前值。
	 *
	 * 一律重新读，不用 c.get() 里那份：批准是直接写表的，那份是请求开始时的旧值，
	 * 用它回给前端，页面会显示成「批准了但没变」。
	 */
	load: (c: Ctx) => Promise<T> | T;
	/** 表单描述；选项要查库的（Accounts OIDC 的 Issuer 列表）所以允许异步。 */
	formPage: (c: Ctx, current: T) => Promise<FormPageConfig> | FormPageConfig;
	/** 请求体 → 待保存的值；返回字符串表示校验不通过，按 400 回。 */
	parse: (c: Ctx, body: Record<string, unknown>, current: T) => Promise<T | string> | T | string;
	/** 回给前端的值，默认原样；客户端密钥一类不能回显的在这里抹掉。 */
	present?: (c: Ctx, value: T) => Promise<unknown> | unknown;
	/**
	 * 真正写进配置库的值，默认整个 value。
	 *
	 * 站点配置那三张表单共用一个 SiteSettings 对象，却各存各的一条——这里把对象裁成
	 * 这张表单管的那几个字段，否则三条各存一份全量，谁最后保存谁说了算。
	 */
	project?: (value: T) => unknown;
	/** 写回本次请求上下文，让同一个响应里别处读到的是新值。 */
	apply?: (c: Ctx, value: T) => void;
	/** 保存成功的提示语。 */
	saved: string;
	/** 保存成功的展示方式；默认页内 inline 提示。 */
	savedFeedback?: ApiFeedbackOptions;
	/** 本页独有的动作（比如「测试配置」）；处理了就返回响应，没处理返回 undefined。 */
	action?: (c: Ctx, current: T) => Promise<Response | undefined>;
};

/** 四个设置页共用的处理流程。 */
export const settingsPageHandler = <T,>(page: SettingsPage<T>): ApiHandler => async (c, next) => {
	const rowId = await configRowId(c, page.key);
	const pageData = async (value: T) => {
		const notice = await pendingApprovalNotice(c, 'base_configs', rowId);
		const formPage = await page.formPage(c, value);
		return {
			currentValues: page.present ? await page.present(c, value) : value,
			formPage: notice ? { ...formPage, notice } : formPage,
		};
	};
	// 撤销申请 / 批准 / 驳回：提交后进了审批队列，页面上得看得见、也动得了。
	const handled = await handlePendingApprovalAction(c, 'base_configs', rowId);
	if (handled) {
		if (!handled.ok) return apiMessage(c, 409, handled.message);
		// 回整页数据而不只是一句消息：批准之后值变了、提示块该消失了，只回消息的话
		// 页面还停在原样，看起来像什么都没发生。
		const current = await page.load(c);
		page.apply?.(c, current);
		return apiMessageData(c, 200, handled.message, await pageData(current), { component: 'inline', showIcon: true, title: '审批结果' });
	}
	if (page.action && c.req.query('action')) {
		const response = await page.action(c, await page.load(c));
		if (response) return response;
	}
	if (c.req.method === 'GET') return apiResponse(c, 200, await pageData(await page.load(c)));
	if (c.req.method === 'PUT') {
		const current = await page.load(c);
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const parsed = await page.parse(c, body, current);
		if (typeof parsed === 'string') return apiMessage(c, 400, parsed);
		try {
			await c.get('configStore').put(page.key, page.project ? page.project(parsed) : parsed);
		} catch (error) {
			// 进了审批队列。就地接住而不是让它冒到全局处理器：那里只回一句话，页面上
			// 既看不到刚提交的申请，也没法撤销，非得刷新一次才认。回整页数据就地更新。
			if (!(error instanceof PendingApprovalError)) throw error;
			return apiMessageData(c, 202, error.message, await pageData(current), { component: 'inline', type: 'warning', showIcon: true, title: '已提交审批' });
		}
		page.apply?.(c, parsed);
		return apiMessageData(c, 200, page.saved, await pageData(parsed), page.savedFeedback ?? { component: 'inline', showIcon: true, title: '保存结果' });
	}
	return next();
};
