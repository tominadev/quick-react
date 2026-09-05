export type UserIdentity = {
	id: number | string;
	user_name: string;
	roles: string[];
	/** 账号所属租户（base_users.owner_tid）；平台自有账号为 null。 */
	tenantId?: string | null;
};

/** 业务站点启用 Accounts 登录时，个人中心提供的账号中心入口（始终在新页面打开）。 */
export type AccountCenterLink = { label: string; url: string };
