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
	/** 可以自己批自己申请的用户（base_users.id，逗号分隔）。未设置时默认「1」，见 super-users.mts。 */
	SUPER_USER_IDS?: string | number;
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
		/**
		 * 协议接口验完凭证之后得到的**主体**。
		 *
		 * `/api/panel/` 的身份来自会话，而协议接口（`/api/token/`、`/api/ed25519/`）的身份
		 * 跟着请求走。目录级中间件在进入叶子之前验完凭证并把结果放在这里，叶子只管业务，
		 * 不再各自重复一遍「取头、算摘要、查表、比对」。
		 *
		 * `kind` 说的是**凭什么进来的**，不同凭证的有效期与泄露后果不同（静态令牌长期有效、
		 * 签名票据一次性），叶子偶尔需要据此收窄。
		 */
		protocolSubject?: { kind: 'token' | 'ed25519'; ownerUid: string; deviceId?: string };
		/**
		 * 生成器凭证解析出来的机器。
		 *
		 * 与 `protocolSubject` 分开，因为它**不属于任何账号**：平台预配凭证不能提交短信、
		 * 不能绑定手机，只能登记令牌与上传文件。合进 protocolSubject 会让叶子拿到一个
		 * `ownerUid` 为空的「账号主体」，那正是最容易被误用的形状。
		 *
		 * `name` 是对象键里的目录名，由服务端从凭证解析——工具自称的标识不作数，伪造就意味着
		 * 一台机器能把文件写进另一台的目录。
		 */
		generatorMachine?: { id: string; name: string };
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
		/** 列表查询选出了哪些列；响应层据此标注哪些列可排序。由 tableSort 在查询执行时写入。 */
		sortableFields?: string[];
	};
};

export type MockRow = TableRow;
export type MockColumn = TableColumn;
export type MockTable = { columns: MockColumn[]; rows: MockRow[] };
