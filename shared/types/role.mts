import type { TableSelectOption } from './table.mjs';

/**
 * 角色与代码里的导航、接口守卫强绑定，属于不会随数据变化的常量，集中定义在这里，不进数据库。
 * assignable 为 false 的角色由运行时隐式授予，不允许在用户管理里分配。
 */
export type SystemRoleDefinition = {
	value: string;
	label: string;
	assignable: boolean;
	description: string;
};

export const systemRoles: SystemRoleDefinition[] = [
	{ value: 'public', label: '访客', assignable: false, description: '任何请求都隐式拥有的角色' },
	{ value: 'user', label: '登录用户', assignable: false, description: '任何已登录用户隐式拥有的角色' },
	{ value: 'accounts', label: 'Accounts 用户', assignable: false, description: '存在 Accounts 会话时隐式拥有的角色' },
	// 角色名统一为 <范围>_<职能>：读到角色键即可判断可见范围，写角色门时不会误放行。
	{ value: 'platform_admin', label: '平台管理员', assignable: true, description: '跨租户，管理租户、分站、站点与数据库' },
	{ value: 'platform_support', label: '平台客服', assignable: true, description: '代查任意租户内指定账号，每次留审计记录' },
	{ value: 'tenant_admin', label: '租户管理员', assignable: true, description: '本租户全部数据；不能访问控制面与租户管理' },
	{ value: 'tenant_support', label: '租户客服', assignable: true, description: '代查本租户内指定账号，每次留审计记录' },
	{ value: 'branch_admin', label: '分站管理员', assignable: true, description: '本分站全部数据' },
	{ value: 'branch_support', label: '分站客服', assignable: true, description: '代查本分站内指定账号，每次留审计记录' },
	{ value: 'agent', label: '代理', assignable: true, description: '名下下级用户的管理视图；代查范围限自己发展的账号' },
];

/** 不受行级归属判定约束的角色。 */
export const isPlatformAdminRole = (roles: string[]) => roles.includes('platform_admin');
/** 可见本租户全部数据的角色。 */
export const isTenantAdminRole = (roles: string[]) => roles.includes('tenant_admin');
/** 可见本分站全部数据的角色。 */
export const isBranchAdminRole = (roles: string[]) => roles.includes('branch_admin');

const roleMap = new Map(systemRoles.map((role) => [role.value, role]));

/** 统一的角色展示格式：中文名(英文键)；未登记的历史角色原样展示并标注。 */
export const roleLabel = (value: string) => {
	const role = roleMap.get(value);
	return role ? `${role.label}(${role.value})` : `${value}（未知角色）`;
};

export const assignableRoles = systemRoles.filter((role) => role.assignable);

export const assignableRoleOptions = assignableRoles.map((role) => ({
	value: role.value,
	text: roleLabel(role.value),
})) satisfies TableSelectOption[];

const assignableRoleValues = new Set(assignableRoles.map((role) => role.value));

/** 兼容数组和历史 JSON 文本两种输入，非法内容按空角色处理。 */
export const parseRoles = (value: unknown): string[] => {
	const source = typeof value === 'string' && value.trim().startsWith('[')
		? (() => { try { return JSON.parse(value) as unknown; } catch { return []; } })()
		: value;
	if (typeof source === 'string') return source.trim() ? [source.trim()] : [];
	if (!Array.isArray(source)) return [];
	return [...new Set(source.filter((role): role is string => typeof role === 'string' && role.trim() !== '').map((role) => role.trim()))];
};

/** 返回数据库适配器可直接绑定的数组；PostgreSQL 使用 String[]，其他方言由适配器序列化为 JSON 文本。 */
export const serializeRoles = (roles: string[]) => roles;

/** 返回白名单之外的角色，用于接口层拒绝非法输入。 */
export const unknownAssignableRoles = (roles: string[]) => roles.filter((role) => !assignableRoleValues.has(role));
