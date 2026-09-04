import type { ConfigStore } from './config-store.mjs';

export type SiteSettings = { contactEmail: string; footer: string; logoutLocalEnabled: boolean; logoutPassportEnabled: boolean; logoutAllEnabled: boolean; apiBootstrapEnabled: boolean; auditRetentionDays: number };

/** 审计保留期上限十年：再长也没有取证价值，却会让表无限增长。0 表示不自动清理。 */
export const maxAuditRetentionDays = 3650;
export const defaultAuditRetentionDays = 365;
export const defaultSiteSettings: SiteSettings = { contactEmail: '', footer: `Ant Design ©${new Date().getFullYear()} Created by Ant UED`, logoutLocalEnabled: false, logoutPassportEnabled: false, logoutAllEnabled: true, apiBootstrapEnabled: true, auditRetentionDays: 365 };
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
	};
};
export const loadSiteSettings = async (store: ConfigStore) => normalizeSiteSettings(await store.get('site-settings'));
