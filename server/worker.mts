import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { compress } from 'hono/compress';
import { etag } from 'hono/etag';
import { renderIndexHtml } from './templates/base/index.mjs';
import { createApiGateway } from './modules/base/api-router.mjs';
import { accountsIdentityApi, getFullSiteNavigation, getPageDefinitions, getPageMetadata, getSiteNavigation, siteProvidesApi } from './modules/base/navigation.mjs';
import { buildAuthState, resolvePagePaths, resolvePageStatus } from './modules/base/page-context.mjs';
import { createDatabaseConfigStore } from './modules/base/config-store.mjs';
import { createD1Adapter, type D1DatabaseLike } from './database/d1.mjs';
import { apiMessage } from './modules/base/api-response.mjs';
import { oidcDiscovery } from './modules/passport/accounts/provider.mjs';
import { withDatabaseActors, type DatabaseAdapter } from './database/index.mjs';
import { resolveHostScope } from './modules/base/tenant.mjs';
import { SiteRouter } from './modules/base/site-router.mjs';
import { baseSessionMaxAge, createSessionCookie, loadBaseDeviceUserId, loadCurrentUser, readSessionId, sessionUsesAccountsOidc } from './modules/base/auth/index.mjs';
import { loadAccountsOidcConfig, resolveAccountsLoginMode } from './modules/passport/accounts/client.mjs';
import { PendingApprovalError } from './modules/base/operation.mjs';
import { clearPassportSessionCookie, loadPassportDeviceUserId, loadPassportSession, readPassportSessionId } from './modules/passport/session.mjs';
import { loadSystemConfigFromStore } from './modules/base/system-config.mjs';
import { applyTechStackHeaders, loadTechStackConfigFromStore } from './modules/base/tech-stack.mjs';
import { isSecureRequest, requestPagePath } from './modules/base/request-origin.mjs';
import { getClientIp, getTransportIp } from './modules/base/client-ip.mjs';
import { loadSiteSettings } from './modules/base/site-settings.mjs';
import { renderPrivacyHtml } from './templates/base/page/privacy.mjs';
import { renderTermsHtml } from './templates/base/page/terms.mjs';
import { renderWechatQrPage } from './templates/passport/accounts/external/wechat.mjs';
import { parseRoles } from '@shared/types/role.mjs';
import { normalizePagePath, stripPageSuffix } from '@shared/navigation-tree.mjs';
import type { AppEnv, RuntimeBindings } from './modules/base/types.mjs';
import { workerApiModules, workerApiRoutes } from './.generated/worker-api-registry.mjs';
import { configurationBucket as sharedConfigurationBucket } from './modules/base/configuration-cache.mjs';

export type WorkerBindings = RuntimeBindings & {
	ASSETS?: { fetch: (request: Request) => Promise<Response> };
};

type WorkerEnv = AppEnv & { Bindings: WorkerBindings };
const app = new Hono<WorkerEnv>();
const adapters = new WeakMap<object, DatabaseAdapter>();
const routers = new WeakMap<object, SiteRouter>();
type CachedConfiguration = {
	loadedAt: number;
	systemConfig: Awaited<ReturnType<typeof loadSystemConfigFromStore>>;
	techStackConfig: Awaited<ReturnType<typeof loadTechStackConfigFromStore>>;
	siteSettings: Awaited<ReturnType<typeof loadSiteSettings>>;
};
// 配置按租户独立，缓存键必须是（库，租户）而不只是库。缓存本体在 configuration-cache，
// 因为审批通过那条路径也要能清它，而那里够不着 worker。
const configurationBucket = (database: object) => sharedConfigurationBucket(database) as Map<string, CachedConfiguration>;

const asAdapter = (binding: unknown): DatabaseAdapter | undefined => {
	if (!binding || typeof binding !== 'object' || !('prepare' in binding)) return undefined;
	const object = binding as object;
	let adapter = adapters.get(object);
	if (!adapter) {
		adapter = createD1Adapter(binding as D1DatabaseLike);
		adapters.set(object, adapter);
	}
	return adapter;
};

const resolveSiteDatabase = async (c: Context<WorkerEnv>, site: Parameters<NonNullable<RuntimeBindings['DATABASE_RESOLVER']>>[0], defaultDatabase: DatabaseAdapter) => {
	if (c.env.DATABASE_RESOLVER) return c.env.DATABASE_RESOLVER(site);
	if (site.databaseTarget.kind === 'binding') return asAdapter(c.env[site.databaseTarget.value]);
	if (site.databaseTarget.kind === 'default') return defaultDatabase;
	return undefined;
};

const configureForRequest = async (c: Context<WorkerEnv>) => {
	const defaultBinding = c.env.DEFAULT_DB;
	const defaultDatabase = asAdapter(defaultBinding);
	if (!defaultDatabase || !defaultBinding || typeof defaultBinding !== 'object') return false;
	let siteRouter = routers.get(defaultBinding);
	if (!siteRouter) {
		siteRouter = new SiteRouter(defaultDatabase);
		routers.set(defaultBinding, siteRouter);
	}
	const site = await siteRouter.resolve(c.req.raw);
	if (!site) return false;

	const database = await resolveSiteDatabase(c, site, defaultDatabase);
	if (!database) throw new Error(`Database target is unavailable for site ${site.siteKey}`);
	// 自带 Accounts 身份的站点用自己的库；控制面额外连一份用于校验关联数据。业务站点只走 OIDC，不直连身份库。
	const accountsIdentity = siteProvidesApi(site.codeSiteChain, accountsIdentityApi);
	const passportSite = accountsIdentity ? site : site.isSystem ? await siteRouter.resolveByApi(accountsIdentityApi, site.hostname) : undefined;
	let passportDatabase: DatabaseAdapter | undefined;
	if (passportSite) {
		try { passportDatabase = passportSite.siteKey === site.siteKey ? database : await resolveSiteDatabase(c, passportSite, defaultDatabase); }
		catch { /* Global administration remains available if Passport storage is temporarily unavailable. */ }
	}

	// 租户与分站必须在读取配置之前定下来：配置按租户独立，而它们只依赖 base_hosts，不依赖配置。
	const hostScope = await resolveHostScope(database, site.hostname).catch(() => ({ tenantId: null, branchId: null }));
	const baseTenantId = hostScope.tenantId;
	const baseBranchId = hostScope.branchId;
	const tenantCacheKey = String(baseTenantId ?? '');
	// 写配置要落到当前租户，因此用绑定过租户的适配器；读取由 config store 自己按租户加回落处理。
	const configDatabase = withDatabaseActors(database, { baseTenantId, baseBranchId });
	const baseConfigStore = createDatabaseConfigStore(configDatabase, baseTenantId);
	const configStore = {
		get: baseConfigStore.get,
		put: async (key: string, value: unknown) => {
			await baseConfigStore.put(key, value);
			configurationBucket(database as object).delete(tenantCacheKey);
		},
	};
	let configuration = configurationBucket(database as object).get(tenantCacheKey);
	if (!configuration || Date.now() - configuration.loadedAt >= 30_000) {
		const [systemConfig, techStackConfig, siteSettings] = await Promise.all([
			loadSystemConfigFromStore(configStore),
			loadTechStackConfigFromStore(configStore),
			loadSiteSettings(configStore),
		]);
		configuration = { loadedAt: Date.now(), systemConfig, techStackConfig, siteSettings };
		configurationBucket(database as object).set(tenantCacheKey, configuration);
	}
	c.set('site', site);
	c.set('globalDatabase', defaultDatabase);
	if (passportDatabase) c.set('passportDatabase', passportDatabase);
	c.set('database', database);
	c.set('siteRouter', siteRouter);
	c.set('configStore', configStore);
	c.set('systemConfig', configuration.systemConfig);
	c.set('siteSettings', configuration.siteSettings);
	c.set('techStackConfig', configuration.techStackConfig);
	const trustedProxyRules = configuration.systemConfig.trustedProxyIps.split(',').map((ip) => ip.trim()).filter(Boolean);
	c.set('clientIp', getClientIp(c, trustedProxyRules));
	c.set('transportIp', getTransportIp(c));
	c.set('accountsIdentity', accountsIdentity);
	const accountsConfig = await loadAccountsOidcConfig(c);
	const accountsLoginMode = resolveAccountsLoginMode(accountsConfig, configuration.siteSettings.localLoginEnabled);
	c.set('accountsLoginMode', accountsLoginMode);
	const storedCurrentUser = await loadCurrentUser(database, c.req.raw);
	const oidcSession = storedCurrentUser && await sessionUsesAccountsOidc(database, c.req.raw);
	// 开关切换后不继续接受上一种登录方式遗留的 Cookie；both 模式两种会话都认。
	const sessionMatchesMode = accountsLoginMode === 'both'
		|| (accountsLoginMode === 'oidc' ? oidcSession : !oidcSession);
	const currentUser = storedCurrentUser && sessionMatchesMode ? storedCurrentUser : undefined;
	if (currentUser) c.set('currentUser', currentUser);
	const apiBootstrapDocument = configuration.siteSettings.apiBootstrapEnabled
		&& c.req.method === 'GET'
		&& (c.req.header('accept') ?? '').includes('text/html');
	if (currentUser && c.req.method !== 'DELETE' && !apiBootstrapDocument) {
		const sessionId = readSessionId(c.req.raw);
		if (sessionId) c.header('Set-Cookie', createSessionCookie(sessionId, isSecureRequest(c), baseSessionMaxAge));
	}
	// Accounts 会话与站点本地会话相互独立，存在时额外授予 accounts 角色。
	const passportSessionId = readPassportSessionId(c.req.raw);
	const passportUser = passportDatabase && accountsIdentity
		? await loadPassportSession(passportDatabase, c.req.raw)
		: undefined;
	if (passportSessionId && !passportUser && !apiBootstrapDocument) c.header('Set-Cookie', clearPassportSessionCookie(isSecureRequest(c)), { append: true });
	if (passportUser) c.set('passportUser', passportUser);
	// Bind the authenticated device-user IDs once per request.  The SQL public
	// layer then fills created/updated audit fields for every route uniformly.
	const baseDeviceUserId = currentUser ? await loadBaseDeviceUserId(database, c.req.raw) : null;
	const passportDeviceUserId = passportUser && passportDatabase ? await loadPassportDeviceUserId(passportDatabase, c.req.raw) : null;
	// 行级判定的主体角色必须在建适配器之前算好：绑定了角色的适配器才受判定约束，
	// 未绑定的（database 本身）是系统上下文，供鉴权、迁移、配置读取等使用。
	const subjectRoles = [
		'public',
		...(currentUser ? ['user', ...currentUser.roles] : []),
		...(passportUser ? ['accounts'] : []),
	];
	const baseUserId = currentUser?.id ?? null;
	const passportUserId = passportUser?.id ?? null;
	// Passport administration is authorized by the site's Base admin session.
	// When both layers share one database and no Accounts session is present,
	// the Base device-user binding is therefore the only valid audit actor.
	const passportActor = passportDeviceUserId ?? (passportDatabase === database ? baseDeviceUserId : null);
	// 人工操作 = 管理后台与账户中心的表单提交。登录、OIDC 回调、Telegram webhook、
	// 迁移与清理都不在这个前缀下，因此它们的写入不需要走操作层，也不留痕。
	// 判定放在这里而不是路由的角色门上：三个站点各有自己的 panel 目录，
	// 按路径判一次比在每个站点各挂一道守卫更难漏。
	const humanOperation = new URL(c.req.url).pathname.startsWith('/api/panel/');
	const scopedDatabase = withDatabaseActors(database, {
		humanOperation,
		base: baseDeviceUserId,
		baseUserId,
		baseTenantId,
		baseBranchId,
		subjectRoles,
		...(passportDatabase === database ? { passportUserId } : {}),
		...(passportDatabase === database ? { passport: passportActor } : {}),
	});
	const scopedPassportDatabase = passportDatabase && passportDatabase !== database
		? withDatabaseActors(passportDatabase, { humanOperation, passport: passportDeviceUserId, passportUserId })
		: scopedDatabase;
	const globalDeviceUserId = defaultDatabase === database ? baseDeviceUserId : await loadBaseDeviceUserId(defaultDatabase, c.req.raw).catch(() => null);
	const globalUser = defaultDatabase === database ? currentUser : await loadCurrentUser(defaultDatabase, c.req.raw).catch(() => undefined);
	const globalUserId = globalUser?.id ?? null;
	const scopedGlobalDatabase = defaultDatabase === database
		? scopedDatabase
		: await (async () => {
			const globalScope = await resolveHostScope(defaultDatabase, site.hostname).catch(() => ({ tenantId: null, branchId: null }));
			return withDatabaseActors(defaultDatabase, { humanOperation, base: globalDeviceUserId, baseUserId: globalUserId, baseTenantId: globalScope.tenantId, baseBranchId: globalScope.branchId });
		})();
	// 配置读取不参与行级判定：配置行没有账号归属，绑定主体后普通账号一条都读不到，
	// 登录表单、站点设置这些未登录也要用的东西会全部失效。读走未绑定适配器（configDatabase
	// 只绑了租户与分站，没有主体角色），写仍走绑定适配器以维护审计字段。
	const scopedConfigWriter = createDatabaseConfigStore(withDatabaseActors(scopedDatabase, { baseTenantId, baseBranchId }), baseTenantId, c);
	c.set('globalDatabase', scopedGlobalDatabase);
	c.set('passportDatabase', scopedPassportDatabase);
	// 登录、注册、OIDC 回调等发生在会话建立之前的读取必须用它，否则会被自己的判定挡住。
	c.set('systemDatabase', database);
	if (passportDatabase) c.set('systemPassportDatabase', passportDatabase);
	c.set('systemGlobalDatabase', defaultDatabase);
	c.set('database', scopedDatabase);
	c.set('tenantId', baseTenantId);
	c.set('branchId', baseBranchId);
	c.set('configStore', {
		get: baseConfigStore.get,
		put: async (key: string, value: unknown) => {
			await scopedConfigWriter.put(key, value);
			configurationBucket(database as object).delete(tenantCacheKey);
		},
	});
	// Accounts 会话只带来身份（accounts 角色），站点权限一律来自本站用户自己的角色。
	c.set('effectiveRoles', [
		'public',
		...(currentUser ? ['user', ...currentUser.roles] : []),
		...(passportUser ? ['accounts'] : []),
	]);
	c.set('apiContext', async (pathValue) => {
		// 登录或退出接口会在同一请求里更新会话；根据最新上下文重新计算角色，
		// 让带 refreshAuth 的响应可以直接携带新的认证状态，不再依赖独立 /api/auth 请求。
		const current = c.get('currentUser');
		const passport = c.get('passportUser');
		const effectiveRoles = [
			'public',
			...(current ? ['user', ...parseRoles(current.roles)] : []),
			...(passport ? ['accounts'] : []),
		];
		c.set('effectiveRoles', effectiveRoles);
		const auth = await buildAuthState(c);
		let requestPath = pathValue ?? requestPagePath(c);
		try { requestPath = new URL(requestPath, 'http://localhost').pathname.slice(0, 256) || '/'; }
		catch { requestPath = '/'; }
		const pagePaths = resolvePagePaths(c, auth);
		const pageStatus = await resolvePageStatus(c, requestPath, auth, pagePaths);
		return {
			auth,
			siteNavigation: getSiteNavigation(site.codeSiteChain, effectiveRoles),
			...(pageStatus ? { pageStatus } : {}),
		};
	});
	return true;
};

const renderDocument = async (c: Context<WorkerEnv>) => {
	const site = c.get('site');
	const siteConfig = c.get('techStackConfig');
	const systemConfig = c.get('systemConfig');
	const apiBootstrap = c.get('siteSettings').apiBootstrapEnabled;
	// 即使 API 启动模式不把认证数据写入 HTML，也要用后端完整页面集合处理规范后缀。
	const auth = await buildAuthState(c);
	const requestPath = c.req.path;
	const pagePaths = resolvePagePaths(c, auth);
	// 页面后缀、尾斜杠和目录 index 都在服务端统一解析为同一个逻辑页面，
	// 页面内容本身直接返回，不用 3xx 重定向影响 CDN 缓存。
	const logicalRequestPath = normalizePagePath(requestPath, siteConfig.pageSuffix);
	const page = getPageDefinitions(getFullSiteNavigation(site.codeSiteChain)).find((item) => item.path === logicalRequestPath);
	// 目录访问遵循常见 Web 服务器约定：无尾斜杠的目录先规范化到目录 URL，
	// 并明确禁止缓存这个规范化响应；带尾斜杠和 index 页面都直接返回 200。
	if (page?.component === 'panelRoot' && requestPath === logicalRequestPath && requestPath !== '/') {
		const target = new URL(c.req.url);
		c.header('Cache-Control', 'no-store');
		return c.redirect(`${requestPath}/${target.search}`, 302);
	}
	const menuItems = apiBootstrap ? [] : getSiteNavigation(site.codeSiteChain, c.get('effectiveRoles'));
	const pageStatus = apiBootstrap ? undefined : await resolvePageStatus(c, requestPath, auth, pagePaths);
	const metadata = apiBootstrap
		? { title: site.title, description: `${site.title}提供网站页面与接口服务。` }
		: pageStatus
			? { title: pageStatus.title, description: pageStatus.description }
			: getPageMetadata(logicalRequestPath, menuItems, siteConfig.pageSuffix);
	const title = metadata.title === 'Quick React' ? site.title : `${metadata.title} | ${site.title}`;
	const publicOrigin = systemConfig.publicOrigin || undefined;
	const canonical = publicOrigin && !pageStatus ? new URL(requestPath, publicOrigin).toString() : undefined;
	const bootstrapApiPath = apiBootstrap ? (() => {
		const logicalPath = logicalRequestPath;
		const authPage = auth.pages.find((item) => stripPageSuffix(item.path, siteConfig.pageSuffix) === logicalPath);
		if (authPage) {
			const endpoint = new URL(authPage.apiPath, c.req.url);
			endpoint.searchParams.set('mode', authPage.mode);
			return `${endpoint.pathname}${endpoint.search}`;
		}
		const dataPath = page?.component === 'panel'
			? page.dashboardPath
			: page?.component === 'dashboard'
				? page.path
				: page?.component === 'home'
					? '/home'
					: page?.component === 'personalCenter' || page?.component === 'form' || page?.component === 'table'
						? page.path
						: undefined;
		return dataPath ? `/api${dataPath}${siteConfig.apiSuffix}` : `/api/home${siteConfig.apiSuffix}`;
	})() : undefined;
	c.header('Cache-Control', apiBootstrap ? 'public, max-age=60, s-maxage=300, must-revalidate' : 'no-cache');
	return c.html(renderIndexHtml({
		...metadata,
		title,
		canonical,
		contactEmail: c.get('siteSettings').contactEmail,
		initialData: {
			debug: systemConfig.debug,
			bootstrapMode: apiBootstrap ? 'api' : 'server',
			...(bootstrapApiPath ? { bootstrapApiPath } : {}),
			apiSuffix: siteConfig.apiSuffix,
			pageSuffix: siteConfig.pageSuffix,
			siteName: site.title,
			siteNavigation: apiBootstrap ? [] : menuItems,
			...(apiBootstrap ? {} : { auth }),
			footer: c.get('siteSettings').footer,
			pageStatus,
		},
	}), (pageStatus?.status ?? 200) as ContentfulStatusCode);
};

/**
 * 待审批不是错误，不该出现在错误日志里。
 *
 * Hono 的 compose 在每一层 dispatch 里就地 catch 并交给 onError，因此这里是它的
 * 第一落点；不接管的话会走默认处理——打一条错误日志再返回 500。
 */
app.onError((error, c) => {
	if (error instanceof PendingApprovalError) {
		// 用 message 而不是 modal：模态反馈的「确定」按钮是整页跳转（见 FormPage 的
		// modalFeedback），于是「提交了审批」这条提示点一下就把页面刷掉了，正在填的
		// 东西和刚出现的待审批提示一起没了。提交审批不是需要用户决策的事，一条轻提示就够。
		return apiMessage(c, 202, error.message, { component: 'message', type: 'warning', title: '已提交审批' });
	}
	console.error(error);
	return c.text('Internal Server Error', 500);
});

app.use('*', async (c, next) => {
	try {
		if (!await configureForRequest(c)) return c.text('Site Not Found', 404);
		await next();
		// 兜底：正常路径由上面的 onError 收口，这里防的是**业务路由自己的 catch 把异常吞掉**
		// ——那种情况下 onError 根本不会被调用，路由会照常返回「已保存」。
		// 判据是上下文里的标记，不是异常，也不看当前状态码：只要记成了待审批，
		// 数据就一定没动，任何别的响应都是错的。
		// 必须直接改写 c.res：响应已经被下游 finalize 了，此时 return 出去的新响应会被
		// compose 丢弃（它只在 finalized === false 时才采用返回值）。
		if (c.get('pendingApproval') && c.res.status !== 202) {
			c.res = await apiMessage(c, 202, '修改已提交审批，通过后才会生效', { component: 'modal', showIcon: true, title: '已提交审批' });
		}
		applyTechStackHeaders(c.res.headers, c.req.path, c.get('techStackConfig'));
		return undefined;
	} catch (error) {
		// 待审批不是错误：操作已经记下来了，只是还没生效。抛异常是为了让业务路由后面
		// 那句「已保存」不会执行——它一行都不用改（见需求文档 §11.5）。
		if (error instanceof PendingApprovalError) {
			return apiMessage(c, 202, error.message, { component: 'modal', showIcon: true, title: '已提交审批' });
		}
		console.error(error);
		return apiMessage(c, 503, 'Service configuration unavailable');
	}
});
app.use('*', compress());
app.use('*', etag());

/**
 * 源码映射只允许配置的 IP 访问。Node 侧在 app.mts 里按连接地址拦截，
 * Worker 侧没有连接信息，用 Cloudflare 提供的客户端 IP 做同样的限制。
 */
app.use('*', async (c, next) => {
	if (!c.req.path.endsWith('.map') || !c.env.ASSETS) return next();
	const allowed = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1',
		...c.get('systemConfig').mapAllowedIps.split(',').map((ip) => ip.trim()).filter(Boolean)]);
	const clientIp = c.req.header('cf-connecting-ip')?.trim() ?? '';
	if (!allowed.has(clientIp)) return c.text('Not Found', 404);
	return next();
});
app.use('*', async (c, next) => {
	if (!c.env.ASSETS) return next();
	const assetPath = c.req.path.endsWith('.nocache')
		? c.req.path.slice(0, -'.nocache'.length)
		: c.req.path;
	if (assetPath === c.req.path) return next();
	return c.env.ASSETS.fetch(new Request(new URL(assetPath, c.req.url), c.req.raw));
});

const apiGateway = createApiGateway((c) => c.get('techStackConfig').apiSuffix, {
	routes: workerApiRoutes,
	loadModule: async (file) => workerApiModules[file] ?? {},
});
app.all('/api', apiGateway);
app.all('/api/*', (c, next) => apiGateway(c, next));
app.get('/.well-known/openid-configuration', oidcDiscovery);
app.get('/accounts/external/wechat*', (c, next) => {
	const suffix = c.get('techStackConfig').pageSuffix || '';
	if (c.req.path !== `/accounts/external/wechat${suffix}`) return next();
	const popup = c.req.query('popup') === '1';
	return c.html(renderWechatQrPage(`/api/accounts/external/wechat${c.get('techStackConfig').apiSuffix || ''}`, `/accounts/sign${suffix}${popup ? '?popup=1' : ''}`, popup));
});
app.get('/', renderDocument);
app.get('/page/privacy.html', (c) => c.html(renderPrivacyHtml(c.get('site').title, c.get('siteSettings').contactEmail)));
app.get('/page/terms.html', (c) => c.html(renderTermsHtml(c.get('site').title, c.get('siteSettings').contactEmail)));

app.get('*', async (c, next) => {
	if (c.req.path.startsWith('/api/') || !c.req.header('accept')?.includes('text/html')) {
		if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
		return next();
	}
	return renderDocument(c);
});

app.notFound(async (c) => {
	if (c.req.path.startsWith('/api/')) return apiMessage(c, 404);
	if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
	return c.text('Not Found', 404);
});

export default app;
