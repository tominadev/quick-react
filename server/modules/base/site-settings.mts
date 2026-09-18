import type { ConfigStore } from './config-store.mjs';
import { clampMinUserNameLength, defaultMinUserNameLength } from '@shared/account-name.mjs';

export type SiteSettings = { contactEmail: string; footer: string; logoutLocalEnabled: boolean; logoutPassportEnabled: boolean; logoutAllEnabled: boolean; apiBootstrapEnabled: boolean; auditRetentionDays: number; registrationEnabled: boolean; localLoginEnabled: boolean; passwordSyncEnabled: boolean; userNameMinLength: number; adminMenuFoldable: boolean };

/** 审计保留期上限十年：再长也没有取证价值，却会让表无限增长。0 表示不自动清理。 */
export const maxAuditRetentionDays = 3650;
export const defaultAuditRetentionDays = 365;
/**
 * 站点设置的出厂值。
 *
 * **页脚默认是空的。** 这里原先放的是 antd 官网自己的页脚（`Ant Design ©… Created by Ant UED`，
 * Ant UED 是蚂蚁做 Ant Design 的那个团队）——那句话对 antd 官网是真的，对**任何一个用这套
 * 脚手架部署出来的站点**都是假的：它替部署者声称自己的页面由别人创作、版权归别人。
 *
 * 脚手架的出厂值必须对任何部署者都成立，所以留空——前端见到空串就不渲染页脚（PanelLayout），
 * 想要页脚的人到站点设置里自己填。MIT 要求的署名在打包产物里（esbuild 默认保留 @license
 * 注释），页脚不承担那个义务。
 */
export const defaultSiteSettings: SiteSettings = { contactEmail: '', footer: '', logoutLocalEnabled: false, logoutPassportEnabled: false, logoutAllEnabled: true, apiBootstrapEnabled: true, auditRetentionDays: 365, registrationEnabled: false, localLoginEnabled: false, passwordSyncEnabled: false, userNameMinLength: defaultMinUserNameLength, adminMenuFoldable: false };
export const normalizeSiteSettings = (value: unknown): SiteSettings => {
	const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	return {
		contactEmail: typeof source.contactEmail === 'string' ? source.contactEmail.trim().slice(0, 254) : defaultSiteSettings.contactEmail,
		footer: typeof source.footer === 'string' ? source.footer.trim().slice(0, 512) : defaultSiteSettings.footer,
		logoutLocalEnabled: typeof source.logoutLocalEnabled === 'boolean' ? source.logoutLocalEnabled : false,
		logoutPassportEnabled: typeof source.logoutPassportEnabled === 'boolean' ? source.logoutPassportEnabled : false,
		logoutAllEnabled: typeof source.logoutAllEnabled === 'boolean' ? source.logoutAllEnabled : true,
		apiBootstrapEnabled: typeof source.apiBootstrapEnabled === 'boolean' ? source.apiBootstrapEnabled : true,
		auditRetentionDays: Math.min(Math.max(Math.trunc(Number(source.auditRetentionDays ?? defaultAuditRetentionDays)) || 0, 0), maxAuditRetentionDays),
		// 默认关闭：开着就等于任何人都能在本站建账号，必须是主人主动打开的。
		registrationEnabled: typeof source.registrationEnabled === 'boolean' ? source.registrationEnabled : false,
		// 默认关闭：接入 Accounts 之后只留一个入口是今天的行为，开这个开关才两条并存。
		localLoginEnabled: typeof source.localLoginEnabled === 'boolean' ? source.localLoginEnabled : false,
		// 默认关闭：开着意味着本站库里多一份能直接破出 Accounts 密码的哈希。
		passwordSyncEnabled: typeof source.passwordSyncEnabled === 'boolean' ? source.passwordSyncEnabled : false,
		// 用户名下限可调，上限固定 16——放宽下限是主人的选择，放宽上限只会让界面难排版。
		userNameMinLength: clampMinUserNameLength(source.userNameMinLength),
		// 默认不折叠：顶层那几项是「在哪一块」，摊开来一眼看全。模块多到侧栏装不下时再打开。
		adminMenuFoldable: typeof source.adminMenuFoldable === 'boolean' ? source.adminMenuFoldable : false,
	};
};
/**
 * 站点配置分三条存，与三张设置表单一一对应。
 *
 * **一条存不行**：待审批记录是按「表 + 行」挂的，同一个人对同一行的重复提交会覆盖自己
 * 上一条申请（那条规则本身是对的——否则队列里堆着同一行的多份申请，先批的会让后批的
 * 值校验失败）。三张表单共用一行的话，在前台设置里提交的待审批，会被随后在后台设置里
 * 的提交静悄悄顶掉。分三条之后各排各的队。
 *
 * 运行时仍然是一个 SiteSettings 对象：读的地方（`c.get('siteSettings').footer`）遍布全站，
 * 没有理由让它们关心这个值存在哪一条里。
 */
export const siteSettingsKeys = { frontend: 'site_frontend', backend: 'site_backend', admin: 'admin_settings' } as const;

export const loadSiteSettings = async (store: ConfigStore) => {
	const parts = await Promise.all(Object.values(siteSettingsKeys).map((key) => store.get(key)));
	return normalizeSiteSettings(Object.assign({}, ...parts.map((part) => part && typeof part === 'object' ? part : {})));
};
