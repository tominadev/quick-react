import type { DatabaseAdapter } from '../../database/index.mjs';
import type { SiteRequestContext, SiteRouter } from './site-router.mjs';
import type { ConfigStore } from './config-store.mjs';
import type { SystemConfig } from './system-config.mjs';
import type { TechStackConfig } from './tech-stack.mjs';
import type { SiteSettings } from './site-settings.mjs';
import type { UserIdentity } from '@shared/types/user.mjs';
import type { TableColumn, TableRow } from '@shared/types/table.mjs';
import type { AccountsLoginMode } from '@server/modules/passport/accounts/client.mjs';
import type { ApiContext } from '@shared/types/api-response.mjs';
import type { TableCrudDefinition } from './table-crud.mjs';

export type RuntimeBindings = Record<string, unknown> & {
	DEFAULT_DB?: unknown;
	SNOWFLAKE_WORKER_ID?: string | number;
	DATABASE_RESOLVER?: (site: SiteRequestContext) => Promise<DatabaseAdapter>;
	MIGRATE_SITE?: (siteKey: string) => Promise<void>;
	/** 按 DSN 打开站点数据库，用于连接测试和数据迁移；Worker 运行时不提供。 */
	SITE_DATABASE?: (dsn: string) => DatabaseAdapter;
	OIDC_FETCH?: typeof fetch;
};

export type AppEnv = {
	Bindings: RuntimeBindings;
	Variables: {
		site: SiteRequestContext;
		globalDatabase: DatabaseAdapter;
		passportDatabase?: DatabaseAdapter;
		database: DatabaseAdapter;
		/** 未绑定主体的适配器，跳过行级判定。仅供鉴权、登录前查询与系统任务使用。 */
		systemDatabase: DatabaseAdapter;
		/** 未绑定主体的 Passport 适配器，供 OIDC 等机器对机器的协议端点使用。 */
		systemPassportDatabase?: DatabaseAdapter;
		/** 未绑定主体的控制面适配器，供 webhook 等机器对机器的端点使用。 */
		systemGlobalDatabase: DatabaseAdapter;
		/** 当前请求所属租户，由主机名解析（base_hosts），未绑定时落到默认租户。 */
		tenantId: string | null;
		/** 当前请求所属分站；每个域名都绑定分站，未绑定时落到默认租户的主分站。 */
		branchId: string | null;
		siteRouter: SiteRouter;
		configStore: ConfigStore;
		systemConfig: SystemConfig;
		siteSettings: SiteSettings;
		techStackConfig: TechStackConfig;
		/** 当前 API 资源的公共 TableCRUD 回收能力配置。 */
		tableCrud?: TableCrudDefinition;
		clientIp?: string;
		transportIp?: string;
		accountsIdentity: boolean;
		accountsLoginMode: AccountsLoginMode;
		currentUser?: UserIdentity;
		passportUser?: UserIdentity;
		effectiveRoles: string[];
		/** 本次请求把修改记成了待审批：数据没动，响应必须是 202 而不是「已保存」。 */
		pendingApproval?: { operationId: string; entries: number };
		/** Base 响应层按 include=auth 请求当前认证、导航和页面状态；表格结构和数据用 include=schema,data 请求。 */
		apiContext?: (path?: string) => Promise<ApiContext>;
	};
};

export type MockRow = TableRow;
export type MockColumn = TableColumn;
export type MockTable = { columns: MockColumn[]; rows: MockRow[] };
