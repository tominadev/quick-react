import type { DatabaseAdapter } from '@server/database/index.mjs';
import { firstSql, runSql, sql } from '@server/database/sql.mjs';
import { createDatabaseConfigStore } from '@server/modules/base/config-store.mjs';
import { passwordError } from '@server/modules/base/auth/password-policy.mjs';
import { createStoredPassword } from '@server/modules/base/auth/index.mjs';
import { accountsOidcConfigKey, defaultAccountsOidcConfig, normalizeAccountsOidcConfig } from '@server/modules/passport/accounts/client.mjs';
import { parseRoles, serializeRoles } from '@shared/types/role.mjs';

type MaintenanceInput = Record<string, unknown>;
type AdminRow = { id: string | number | bigint; name: string; password: string; roles: string; status: string; deleted_at: string | number | bigint };

const inputValue = (input: MaintenanceInput, key: string) => typeof input[key] === 'string' ? input[key] as string : '';
const inputText = (input: MaintenanceInput, key: string) => inputValue(input, key).trim();
const usernamePattern = /^[a-zA-Z0-9_.-]{3,64}$/;

const readAdmin = async (database: DatabaseAdapter) => firstSql<AdminRow>(database, sql({ database }).select({
	table: 'base_users',
	columns: { id: 'id', name: 'name', password: 'password', roles: 'roles', status: 'status', deleted_at: 'deleted_at' },
	where: [{ column: 'id', value: 1 }],
	deleted: 'all',
}));

const assertUsernameAvailable = async (database: DatabaseAdapter, username: string) => {
	if (!usernamePattern.test(username)) throw new Error('用户名至少 3 个字符，只能包含字母、数字、点、下划线和短横线');
	const conflict = await firstSql<{ id: string | number | bigint }>(database, sql({ database }).select({
		table: 'base_users',
		columns: { id: 'id' },
		where: [{ column: 'name', value: username }],
		limit: 1,
	}));
	// 用户名现在是租户内唯一，本可以只检查同租户。但救援入口跑在无请求上下文的 CLI 里，
	// 拿不到租户，且 id = 1 的 owner_tid 取决于它当初是被救援创建（NULL）还是经 HTTP 注册
	// 创建（默认租户），无法可靠判定。因此保留全库检查：它比唯一索引更严格，只会多拒不会漏放，
	// 代价仅是救援时不能取一个其他租户已用的名字。
	if (conflict && String(conflict.id) !== '1') throw new Error(`用户名“${username}”已被其他账号占用`);
};

const ensureAdmin = async (database: DatabaseAdapter, input: MaintenanceInput) => {
	const existing = await readAdmin(database);
	const requestedName = inputText(input, 'username');
	const username = requestedName || existing?.name || 'admin';
	await assertUsernameAvailable(database, username);
	const password = inputValue(input, 'password');
	if (password && passwordError(password)) throw new Error(passwordError(password)!);
	if (!existing && !password) throw new Error('base_users.id = 1 不存在，重建管理员时必须提供密码');
	if (existing?.deleted_at && String(existing.deleted_at) !== '0') await runSql(database, sql({ database }).restore('base_users', { id: 1 }));
	const values: Record<string, unknown> = { name: username, roles: serializeRoles([...new Set([...parseRoles(existing?.roles), 'platform_admin'])]), status: 'enabled' };
	if (password) values.password = await createStoredPassword(password);
	if (existing) await runSql(database, sql({ database }).update('base_users', values, { id: 1 }));
	else await runSql(database, sql({ database }).insert('base_users', { id: 1, ...values, password: await createStoredPassword(password) }));
	return `基础管理员 id=1 已恢复：用户名 ${username}，角色已包含 platform_admin，状态已启用`;
};

const setAdminUsername = async (database: DatabaseAdapter, input: MaintenanceInput) => {
	const username = inputText(input, 'username');
	if (!username) throw new Error('请提供管理员用户名');
	await assertUsernameAvailable(database, username);
	if (!await readAdmin(database)) throw new Error('base_users.id = 1 不存在，请先执行基础管理员恢复');
	await runSql(database, sql({ database }).update('base_users', { name: username }, { id: 1 }));
	return `基础管理员 id=1 的用户名已设置为 ${username}`;
};

const setAdminPassword = async (database: DatabaseAdapter, input: MaintenanceInput) => {
	const password = inputValue(input, 'password');
	const error = passwordError(password);
	if (error) throw new Error(error);
	if (!await readAdmin(database)) throw new Error('base_users.id = 1 不存在，请先执行基础管理员恢复');
	await runSql(database, sql({ database }).update('base_users', { password: await createStoredPassword(password) }, { id: 1 }));
	return '基础管理员 id=1 的密码已重设；本站 Base 会话将在下次请求时按现有规则重新校验';
};

const adminStatus = async (database: DatabaseAdapter) => {
	const row = await readAdmin(database);
	if (!row) return 'base_users.id = 1 不存在';
	const roles = parseRoles(row.roles);
	return [`id=1`, `用户名：${row.name}`, `状态：${row.status}`, `删除标记：${String(row.deleted_at)}`, `角色：${roles.join('、') || '无'}`].join('\n');
};

const accountsOidcStatus = async (database: DatabaseAdapter) => {
	const store = createDatabaseConfigStore(database);
	const config = normalizeAccountsOidcConfig(await store.get(accountsOidcConfigKey));
	return [`Accounts OIDC 登录：${config.enabled ? '启用' : '关闭'}`, `Issuer：${config.issuer || '未设置'}`, `客户端 ID：${config.clientId || '未设置'}`, '客户端密钥：已隐藏'].join('\n');
};

const setAccountsOidcEnabled = async (database: DatabaseAdapter, enabled: boolean) => {
	const store = createDatabaseConfigStore(database);
	const current = normalizeAccountsOidcConfig(await store.get(accountsOidcConfigKey));
	await store.put(accountsOidcConfigKey, { ...current, enabled });
	return `Accounts OIDC 登录已${enabled ? '启用' : '关闭'}；Global、Passport 和业务站点共用当前数据库时立即按统一配置生效`;
};

const restoreAccountsOidcDefaults = async (database: DatabaseAdapter) => {
	await createDatabaseConfigStore(database).put(accountsOidcConfigKey, defaultAccountsOidcConfig);
	return 'Accounts OIDC 配置已恢复默认值：登录关闭，Issuer、客户端 ID 和客户端密钥已清空';
};

export const executeMaintenanceAction = async (database: DatabaseAdapter, action: string, input: MaintenanceInput = {}) => {
	switch (action) {
		case 'admin-status': return adminStatus(database);
		case 'restore-admin': return ensureAdmin(database, input);
		case 'set-admin-username': return setAdminUsername(database, input);
		case 'set-admin-password': return setAdminPassword(database, input);
		case 'accounts-oidc-status': return accountsOidcStatus(database);
		case 'disable-accounts-oidc': return setAccountsOidcEnabled(database, false);
		case 'enable-accounts-oidc': return setAccountsOidcEnabled(database, true);
		case 'restore-accounts-oidc-defaults': return restoreAccountsOidcDefaults(database);
		default: throw new Error(`未知维护动作：${action}`);
	}
};
