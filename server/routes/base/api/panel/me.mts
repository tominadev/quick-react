import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiMessageData, apiResponse } from '@server/modules/base/api-response.mjs';

import { passwordError } from '@server/modules/base/auth/password-policy.mjs';
import { firstSql, sql, ownerScope } from '@server/database/sql.mjs';
import { profileNicknameOf, profileStatement } from '@server/modules/base/profile.mjs';
import { runOperation } from '@server/modules/base/operation.mjs';
import { credentialStatement, hasCredential, verifyCredential } from '@server/modules/base/credentials.mjs';
import { loadAccountsOidcConfig } from '@server/modules/passport/accounts/client.mjs';
import { maxNicknameWidth, maxUserNameLength, minNicknameWidth, userNameError } from '@shared/account-name.mjs';
import type { AccountCenterLink } from '@shared/types/user.mjs';
import { SECTION_FIELD, type FormPageConfig } from '@shared/types/form-page.mjs';

type ProfileRow = { user_name: string; profile_nickname: string | null; profile_qq: string | null; profile_wechat: string | null; profile_email: string | null; profile_queued: string | null };

/**
 * 个人中心的三组设置。分成选项卡而不是一张长表单：它们互不相干，一次只改一组，
 * 而且各有各的失败方式——用户名撞名、昵称撞名、当前密码不对。混在一起提交的话，
 * 一处失败会让另外两处也白填。
 */
const profileForm = (values: ProfileRow, hasPassword: boolean): FormPageConfig => ({
	description: '修改本站账号的资料。本站账号与 Accounts 账号各自独立，这里改的只是本站的。',
	/**
	 * 这份资料还没生效时把话说在前面。
	 *
	 * 管理员在后台给一个还没有资料行的用户设了昵称，那是一条**待审批的新建**：整行带着
	 * `queued_at`，对用户不可见。此前这一页什么都不说，表单里三个联系方式全是空的、昵称是
	 * 「未填写」，他改一次显示「已保存」、回头一看还是空——于是反复改。写入那一侧现在会
	 * 拒（QueuedRowError），但只拒不说，就只是把「保存成功但看不见」换成「保存不了也不知道
	 * 为什么」。所以这里把那份还没生效的内容原样显示出来，并讲清它的状态。
	 */
	...(queuedProfile(values) ? { notice: {
		type: 'warning' as const,
		title: '这份资料正在等待管理员审批',
		lines: [
			'管理员设置了你的资料，审批通过之后才会生效——在那之前它只对管理员可见。',
			'下面「个人简介」里显示的就是等着生效的那一份，这段时间不能修改：改了不会生效，只会让那条申请批不动。',
		],
	} } : {}),
	sectionLayout: 'tabs',
	initialValues: {
		user_name: values.user_name,
		// 发真值：没设过昵称就是 null，表单里显示成「未填写，点击填写」。回落到用户名是
		// **显示规则**，在看得到名字的地方做（列表、页面标题），不在这里——在这里回落的话，
		// 「不设昵称」就只能靠「把它改回用户名」这种没人猜得到的操作来表达。
		profile_nickname: values.profile_nickname,
		// 不折成空串：这三个字段的控件认得 NULL，「没填过」和「填过又清掉」要分得开。
		profile_qq: values.profile_qq, profile_wechat: values.profile_wechat, profile_email: values.profile_email,
		currentPassword: '', newPassword: '',
	},
	sections: [
		{
			key: 'user_name', title: '用户名', submitLabel: '保存用户名',
			description: '用户名是登录用的标识，本站内唯一。改掉之后要用新用户名登录。',
			fields: [{ name: 'user_name', label: '用户名', maxLength: maxUserNameLength, extra: `以小写字母开头，只能包含小写字母和数字，最长 ${maxUserNameLength} 位。`, rules: [{ required: true, message: '请输入用户名' }] }],
		},
		{
			key: 'profile', title: '个人简介', submitLabel: '保存简介',
			...(queuedProfile(values) ? { submitHint: '这份资料还在等审批，现在保存会被拒绝。' } : {}),
			fields: [
				{ name: 'profile_nickname', label: '昵称', maxLength: maxNicknameWidth, nullable: true, extra: `显示名，本站内唯一，可以用各国语言；宽度 ${minNicknameWidth} 到 ${maxNicknameWidth} 个半角字符（一个全角按两个半角计）。留作「未填写」就用用户名显示。` },
				{ name: 'profile_qq', label: 'QQ', maxLength: 20, nullable: true },
				{ name: 'profile_wechat', label: '微信号', maxLength: 64, nullable: true },
				{ name: 'profile_email', label: '联系邮箱', maxLength: 254, nullable: true, extra: '本站不做验证，仅作联系方式。' },
			],
		},
		{
			key: 'password', title: hasPassword ? '修改密码' : '设置密码', submitLabel: hasPassword ? '修改密码' : '设置密码',
			description: hasPassword ? '改密码要先验证当前密码。' : '这个账号还没有本站密码。设置之后就能用用户名和密码直接登录本站。',
			fields: [
				...(hasPassword ? [{ name: 'currentPassword', label: '当前密码', type: 'password' as const, rules: [{ required: true, message: '请输入当前密码' }] }] : []),
				{ name: 'newPassword', label: hasPassword ? '新密码' : '密码', type: 'password' as const, extra: '至少 8 个字符。', rules: [{ required: true, message: '请输入密码' }] },
			],
		},
	],
});

/** 这份资料还没生效吗——`queued_at` 非 0 就是还在队列里等着批。 */
const queuedProfile = (values: ProfileRow) => Boolean(values.profile_queued) && String(values.profile_queued) !== '0';

/**
 * `queued: 'all'`：待审批的资料行照样读出来。
 *
 * 默认的 active 作用域会把它从 LEFT JOIN 的 ON 里滤掉，于是这一页显示的是「什么都没设」——
 * 而库里明明有一行写着管理员填的昵称。这一页问的是「我的资料现在是什么状态」，把还没生效
 * 的那一份藏起来，用户就只能靠反复保存去撞墙。生没生效连着一起发（profile_queued），
 * 由这一层显式说明，不靠「读不到」来暗示。
 *
 * 右上角显示的身份不走这里（`currentUser`），因此还没生效的昵称不会漏到对外显示的地方。
 */
const loadProfile = (c: Parameters<ApiHandler>[0], userId: string | number) => firstSql<ProfileRow>(c.get('database'), sql({ database: c.get('database') }).select({
	table: 'base_users', alias: 'u',
	columns: { user_name: 'u.name', profile_nickname: 'p.nickname', profile_qq: 'p.qq', profile_wechat: 'p.wechat', profile_email: 'p.email', profile_queued: { column: 'p.queued_at', cast: 'text' } },
	joins: [{ type: 'LEFT', table: 'base_user_profiles', alias: 'p', left: 'p.user_id', right: 'u.id' }],
	where: [{ column: 'u.id', value: userId }],
	queued: 'all',
}));

/**
 * 个人中心：展示当前登录身份，并允许改自己的用户名、简介与密码。
 *
 * 只能改**自己**这一行——用的是会话里的 currentUser.id，请求体里带别人的 ID 也没用。
 * 账户中心入口始终在新页面打开：业务站点不会把当前页面带去其它域名。
 */
const handler: ApiHandler = async (c, next) => {
	const database = c.get('database');
	const currentUser = c.get('currentUser');
	if (c.req.method === 'GET') {
		const config = await loadAccountsOidcConfig(c);
		let issuer: URL | undefined;
		if (config.enabled && config.issuer) {
			try { issuer = new URL(config.issuer); }
			catch { issuer = undefined; }
		}
		const accounts: { accountsNotice: string; accountsCenter: AccountCenterLink } | undefined = issuer
			? {
				accountsNotice: `本站账号与 Accounts 账号中心（${issuer.host}）各自独立：绑定之后两边的用户名和昵称互不影响，这里改的只是本站账号。点击下面的按钮会在新页面打开账号中心，当前页面不会离开。`,
				accountsCenter: { label: '在新页面打开账号中心', url: `${issuer.origin}/panel/accounts` },
			}
			: undefined;
		const row = currentUser ? await loadProfile(c, currentUser.id) : undefined;
		return apiResponse(c, 200, {
			user: currentUser,
			...(accounts ?? {}),
			...(row ? { formPage: profileForm(row, await hasCredential(database, currentUser!.id)) } : {}),
		});
	}
	if (c.req.method !== 'PUT') return next();
	if (!currentUser) return apiMessage(c, 401, '请先登录');
	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const section = String(body[SECTION_FIELD] ?? '');
	const tenantId = c.get('tenantId');
	const scope = ownerScope('owner_tid', tenantId);
	/**
	 * 保存成功后的响应。
	 *
	 * **只回本段的字段。** 三段共用一份 initialValues，整份回去的话另外两段会被一起重置——
	 * 正在另一个选项卡里输入的内容会凭空消失。
	 *
	 * 只有「有没有本地密码」变化时才回新的 formPage：那一段的标题和字段要从「设置密码」
	 * 翻成「修改密码」。其余情况不动表单结构。
	 *
	 * 身份走两处：`user` 给页面上半截展示，`context.auth.currentUser` 是给右上角的
	 * **局部补丁**——只带变化的那几个字段，客户端按路径合并。不发完整上下文：改个昵称
	 * 而已，导航树、页面状态、可用动作一样都没变，整份传一遍既浪费又容易把没变的东西
	 * 覆盖成空。
	 */
	const hadCredential = await hasCredential(database, currentUser.id);
	const saved = async (message: string, values: Record<string, unknown>) => {
		const row = await loadProfile(c, currentUser.id);
		if (!row) return apiMessageData(c, 200, message, {}, { component: 'inline', showIcon: true, title: '保存结果' });
		const identity = {
			id: currentUser.id, user_name: row.user_name,
			profile_nickname: profileNicknameOf(row.user_name, row.profile_nickname),
			roles: currentUser.roles, tenantId: currentUser.tenantId,
		};
		// 会话里的身份也要就地更新：同一请求后面若还要用到它，拿到的就是新值。
		c.set('currentUser', identity);
		const nowHasCredential = await hasCredential(database, currentUser.id);
		return apiMessageData(c, 200, message, {
			user: identity,
			// 右上角显示的是昵称，而昵称没设时回落到用户名——所以改用户名也要带上它。
			context: { auth: { currentUser: { user_name: identity.user_name, profile_nickname: identity.profile_nickname } } },
			currentValues: values,
			...(nowHasCredential === hadCredential ? {} : { formPage: profileForm(row, nowHasCredential) }),
		}, { component: 'inline', showIcon: true, title: '保存结果' });
	};

	if (section === 'user_name') {
		const userName = String(body.user_name ?? '').trim();
		const error = userNameError(userName, c.get('siteSettings').userNameMinLength);
		if (error) return apiMessage(c, 400, error);
		const taken = await firstSql(database, sql({ database }).select({ table: 'base_users', columns: { id: 'id' }, where: [{ column: 'name', value: userName }, { column: 'id', operator: '!=', value: currentUser.id }, scope], limit: 1 }));
		if (taken) return apiMessage(c, 409, '该用户名已被占用，请换一个');
		await runOperation(c, database, [sql({ database }).update('base_users', { name: userName }, { id: currentUser.id })]);
		return saved('用户名已保存', { user_name: userName });
	}

	if (section === 'profile') {
		const fields = Object.fromEntries((['profile_nickname', 'profile_qq', 'profile_wechat', 'profile_email'] as const)
			.filter((name) => name in body).map((name) => [name, String(body[name] ?? '')]));
		if (!Object.keys(fields).length) return apiMessage(c, 400, '没有可修改的字段');
		const result = await profileStatement(database, currentUser.id, fields, scope);
		if ('error' in result) return apiMessage(c, 400, result.error);
		await runOperation(c, database, ['statement' in result ? result.statement : result.clear]);
		// 按主人要求：这一段只回 profile_ 开头的字段。
		const row = await loadProfile(c, currentUser.id);
		return saved('个人简介已保存', row ? {
			profile_nickname: profileNicknameOf(row.user_name, row.profile_nickname),
			profile_qq: row.profile_qq, profile_wechat: row.profile_wechat, profile_email: row.profile_email,
		} : {});
	}

	if (section === 'password') {
		const newPassword = String(body.newPassword ?? '');
		// 改密码必须先验当前密码：会话被盗时，能改密码就等于能永久接管账号。
		// 还没有密码的账号（走 Accounts 建的）没什么可验，直接设。
		if (hadCredential && !await verifyCredential(database, currentUser.id, String(body.currentPassword ?? ''))) {
			return apiMessage(c, 403, '当前密码不正确');
		}
		const error = passwordError(newPassword);
		if (error) return apiMessage(c, 400, error);
		await runOperation(c, database, [await credentialStatement(database, currentUser.id, newPassword)]);
		// 密码不回显，两个输入框保持空白。
		return saved('密码已保存', { currentPassword: '', newPassword: '' });
	}
	return apiMessage(c, 400, '请选择要保存的一组设置');
};

export default handler;
