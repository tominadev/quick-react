import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';
import { accountsLoginCookieName, clearAccountsLoginCookie, loadAccountsOidcConfig } from '@server/modules/passport/accounts/client.mjs';
import { readCookie } from '@server/modules/passport/accounts/oidc.mjs';
import { withDatabaseActors } from '@server/database/index.mjs';
import { firstSql, runSql, sql, ownerScope } from '@server/database/sql.mjs';
import { isSecureRequest } from '@server/modules/base/request-origin.mjs';
import { createAccountsSession, syncAccountsIdentity } from '@server/modules/base/accounts-link.mjs';
import { hasCredential, setCredential, verifyCredential } from '@server/modules/base/credentials.mjs';
import { readStoredPassword } from '@server/modules/base/auth/index.mjs';
import { finishUserCreation } from '@server/modules/base/registration.mjs';
import { maxUserNameLength, userNameError } from '@shared/account-name.mjs';
import { SECTION_FIELD, type FormPageConfig } from '@shared/types/form-page.mjs';

type PendingChoice = { id: string; issuer: string; subject: string; claims: string; credential: string; return_path: string; expires_at: number; status: string };

/**
 * 首次用某个 Accounts 身份登录本站时的落地页。
 *
 * 回调那边已经验过 ID Token，但没有建号——这一步由用户决定：拿带过来的用户名建个新账号，
 * 还是把这个身份绑到本站已有的账号上。两条路互斥，因此分成两段各自提交，见 FormPageSection。
 */
const choiceForm = (suggested: string): FormPageConfig => ({
	description: '这是你第一次用 Accounts 身份登录本站。可以直接创建一个新账号，或者把这个身份绑定到已有账号上。',
	initialValues: { user_name: suggested },
	sections: [
		{
			key: 'create',
			description: '用下面的用户名在本站创建一个新账号。如果提示已被占用，改一个再试。',
			submitLabel: '创建新账号并登录',
			fields: [{ name: 'user_name', label: '用户名', maxLength: maxUserNameLength, extra: `以小写字母开头，只能包含小写字母和数字，最长 ${maxUserNameLength} 位。`, rules: [{ required: true, message: '请输入用户名' }] }],
		},
		{
			key: 'bind',
			divider: '或',
			description: '本站已经有账号了？填上它的用户名和密码，把这个 Accounts 身份绑上去。绑定后角色和数据都不变。',
			submitLabel: '绑定并登录',
			fields: [
				{ name: 'user_name', label: '本站用户名', maxLength: maxUserNameLength, rules: [{ required: true, message: '请输入本站用户名' }] },
				{ name: 'password', label: '本站密码', type: 'password', rules: [{ required: true, message: '请输入本站密码' }] },
			],
		},
	],
});

const loadPending = async (c: Parameters<ApiHandler>[0]) => {
	const systemDatabase = c.get('systemDatabase');
	const requestId = readCookie(c.req.raw, accountsLoginCookieName);
	if (!requestId) return undefined;
	const row = await firstSql<PendingChoice>(systemDatabase, sql({ database: systemDatabase }).select({
		table: 'base_oidc_login_requests',
		columns: { id: 'request_id', issuer: 'issuer', subject: 'subject', claims: 'claims', credential: 'credential', return_path: 'return_path', expires_at: 'expires_at', status: 'status' },
		where: [{ column: 'request_id', value: requestId }],
	}));
	return row && row.status === 'choosing' && row.expires_at > Date.now() ? row : undefined;
};

const parseClaims = (raw: string) => {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
	} catch { return {}; }
};

/** 落定：写身份映射、同步资料、建会话、清掉这次的登录请求。两条路的收尾完全一样。 */
const settle = async (c: Parameters<ApiHandler>[0], pending: PendingChoice, userId: number, claims: Record<string, unknown>) => {
	const systemDatabase = c.get('systemDatabase');
	const tenantId = c.get('tenantId');
	const scope = ownerScope('owner_tid', tenantId);
	// 身份绑定归属账号本人；这一步还没有本站会话，不显式绑定则 owner_uid 为 NULL。
	// 清 cookie 必须排在建会话**之前**：c.header 不带 append 是覆盖语义，
	// 放在后面会把 createAccountsSession 追加的 base_session 一起抹掉。
	c.header('Set-Cookie', clearAccountsLoginCookie(isSecureRequest(c)));
	const owned = withDatabaseActors(systemDatabase, { baseUserId: userId });
	await runSql(owned, sql({ database: owned }).insert('base_oidc_users', { issuer: pending.issuer, subject: pending.subject, user_id: userId, profile: JSON.stringify(claims) }));
	await syncAccountsIdentity(c, systemDatabase, userId, claims, scope);
	// 密码同步：两侧都要开（Accounts 客户端的「下发密码」+ 本站的「同步 Accounts 密码」），
	// 而且**只在首次绑定这一次**——之后本站密码归本站管，Accounts 那边改密码不再影响这里。
	// 整个 password blob 原样拷过来，hash 和 pattern 都不动，两边账号资料因此完全一致。
	if (pending.credential) {
		const stored = readStoredPassword(JSON.parse(pending.credential) as unknown);
		if (stored) await setCredential(systemDatabase, userId, stored);
	}
	const oidcSessionId = String(claims.sid ?? '');
	if (!oidcSessionId) throw new Error('登录请求缺少会话标识，请重新登录');
	await createAccountsSession(c, systemDatabase, userId, pending.issuer, oidcSessionId);
	// 映射写完再删请求：反过来的话中途失败就既没有映射也没有待决记录，用户只能重新登录。
	await runSql(systemDatabase, sql({ database: systemDatabase }).delete('base_oidc_login_requests', { request_id: pending.id }));
};

const handler: ApiHandler = async (c, next) => {
	const config = await loadAccountsOidcConfig(c);
	if (!config.enabled) return apiMessage(c, 404, '本站未启用 Accounts OIDC 登录');
	const pending = await loadPending(c);
	if (c.req.method === 'GET') {
		if (!pending) return apiMessage(c, 410, 'Accounts 登录已完成或已过期，请重新登录');
		const claims = parseClaims(pending.claims);
		const preferred = typeof claims.preferred_username === 'string' ? claims.preferred_username : '';
		return apiResponse(c, 200, { formPage: choiceForm(userNameError(preferred, c.get('siteSettings').userNameMinLength) ? '' : preferred) });
	}
	if (c.req.method !== 'POST') return next();
	if (!pending) return apiMessage(c, 410, 'Accounts 登录已完成或已过期，请重新登录');
	const systemDatabase = c.get('systemDatabase');
	const tenantId = c.get('tenantId');
	const tenantScope = ownerScope('owner_tid', tenantId);
	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const userName = String(body.user_name ?? '').trim();
	const claims = parseClaims(pending.claims);

	if (body[SECTION_FIELD] === 'create') {
		const error = userNameError(userName, c.get('siteSettings').userNameMinLength);
		if (error) return apiMessage(c, 400, error);
		const taken = await firstSql(systemDatabase, sql({ database: systemDatabase }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: userName }, tenantScope], limit: 1 }));
		if (taken) return apiMessage(c, 409, '该用户名已被占用，请换一个');
		await runSql(systemDatabase, sql({ database: systemDatabase }).insert('base_users', { name: userName, roles: [], status: 'enabled' }));
		const createdId = await finishUserCreation(systemDatabase, userName, tenantId);
		if (createdId === undefined) return apiMessage(c, 500, '无法创建本站账号');
		await settle(c, pending, Number(createdId), claims);
		return apiMessageData(c, 200, '账号已创建', { next: { action: 'navigate', path: pending.return_path, refreshAuth: true } });
	}

	if (body[SECTION_FIELD] !== 'bind') return apiMessage(c, 400, '请选择创建新账号或绑定已有账号');
	const target = await firstSql<{ id: number; status: string }>(systemDatabase, sql({ database: systemDatabase }).select({
		table: 'base_users', columns: { id: 'id', status: 'status' }, where: [{ column: 'name', value: userName }, tenantScope], limit: 1,
	}));
	// 用户名不存在、没有本地密码、密码不对，一律回同一句话：区分开来就成了账号是否存在的探测器。
	const wrong = () => apiMessage(c, 401, '用户名或密码错误');
	if (!target || !await hasCredential(systemDatabase, target.id)) return wrong();
	if (!await verifyCredential(systemDatabase, target.id, String(body.password ?? ''))) return wrong();
	if (target.status !== 'enabled') return apiMessage(c, 403, '该账号已停用');
	// 已经绑过 Accounts 身份的账号不能再绑第二个：一个本站账号对应一个 Accounts 身份，
	// 否则退出登录、后台解绑这些操作都说不清该动哪一条映射。
	const bound = await firstSql(systemDatabase, sql({ database: systemDatabase }).select({
		table: 'base_oidc_users', columns: { id: 'id' }, where: [{ column: 'user_id', value: target.id }, tenantScope], limit: 1,
	}));
	if (bound) return apiMessage(c, 409, '该账号已经绑定过 Accounts 身份');
	await settle(c, pending, target.id, claims);
	return apiMessageData(c, 200, '已绑定并登录', { next: { action: 'navigate', path: pending.return_path, refreshAuth: true } });
};

export default handler;
