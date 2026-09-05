import type React from 'react';
import type { MenuProps } from 'antd';
import type { CommonApi } from '@/utils/common/api.js';
import type { InitialData } from '@shared/types/initial-data.mjs';
import type { AuthState } from '@shared/types/initial-data.mjs';
import type { ApiContext } from '@shared/types/api-response.mjs';
import type { NavigationItem } from '@shared/types/navigation.mjs';
import type { DashboardData } from '@shared/types/dashboard.mjs';
import type { HomePageData } from '@shared/types/home.mjs';
import type { FormPageResponse } from '@shared/types/form-page.mjs';
import type { TableResponse } from '@shared/types/table.mjs';
import type { AccountCenterLink, UserIdentity } from '@shared/types/user.mjs';
import { collectPageDefinitions, matchNavigationKey, normalizePagePath, stripPageSuffix, type NavigationPageDefinition } from '@shared/navigation-tree.mjs';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { BrowserRouter as Router, Navigate, Routes, Route } from 'react-router-dom';
import { Layout, Menu, Result, Space } from 'antd';
import { AppstoreOutlined, MailOutlined } from '@ant-design/icons';
import DescribeInstances from './components/aliyun/DescribeInstances.js';
import Panel from './components/panel/PanelLayout.js';
import Dashboard from './components/panel/Dashboard.js';
import TableCRUD from '@/utils/antd/table_crud/index.js';
import FormPage from './components/panel/FormPage.js';
import AuthActions from './components/AuthActions.js';
import PersonalCenter from './components/panel/PersonalCenter.js';
import ExternalCallback from './components/accounts/ExternalCallback.js';
import StatusPage from './components/common/StatusPage.js';
import HomePage from './components/common/HomePage.js';
import { apiNavigationEvent, type ApiNavigationEventDetail } from '@/utils/common/response-action.js';
const { Content } = Layout;

type MenuItem = Required<MenuProps>['items'][number];

const serverData = (window as Window & { __INITIAL_DATA__?: InitialData }).__INITIAL_DATA__;
const initialData = serverData ?? { apiSuffix: '', pageSuffix: '', siteName: 'Quick React', siteNavigation: [] };
const pageUrl = (path: string) => path === '/' ? path : `${path}${initialData.pageSuffix}`;
const pageRouteAliases = (page: PageDefinition) => {
	const canonical = pageUrl(page.path);
	const aliases = [canonical];
	if (page.path !== '/') {
		aliases.push(page.path, `${page.path}/`, `${canonical}/`);
		if (page.component === 'panelRoot') aliases.push(`${page.path}/index${initialData.pageSuffix}`);
	}
	return [...new Set(aliases)];
};

type PageDefinition = NavigationPageDefinition;
type BootstrapResponse = FormPageResponse & {
	context?: ApiContext;
	home?: HomePageData;
	dashboard?: DashboardData;
	table?: TableResponse;
	user?: UserIdentity;
	accountsNotice?: string;
	accountsCenter?: AccountCenterLink;
};
type BootstrapPageData = { pagePath: string; apiPath: string; response: BootstrapResponse };

const iconComponents = {
	mail: <MailOutlined />,
	appstore: <AppstoreOutlined />,
};
const toMenuItems = (menu: NavigationItem[]): MenuItem[] => menu.filter((item) => !item.hidden).map((item) => ({
	label: item.label,
	key: item.key,
	icon: iconComponents[item.icon as keyof typeof iconComponents],
	// 管理后台根入口是一个可点击的目录页面；顶部菜单不展开它的后台子菜单，
	// 进入后由 panelRoot 页面切换到后端下发的默认 Dashboard。
	// 其余有子菜单的项只展开不跳转，理由同 PanelLayout。
	children: item.children && item.component !== 'panelRoot' ? toMenuItems(item.children) : undefined,
}));


type AppType = {
	commonApi: CommonApi;
};

export const App = ({ commonApi }: AppType) => {
	const location = useLocation();
	const navigate = useNavigate();
	const [contextReady, setContextReady] = useState(initialData.bootstrapMode !== 'api');
	const [contextError, setContextError] = useState(false);
	const [pageStatus, setPageStatus] = useState(initialData.pageStatus);
	const [auth, setAuth] = useState<AuthState | undefined>(initialData.auth);
	const [navigation, setNavigation] = useState(initialData.siteNavigation);
	const [bootstrapPageData, setBootstrapPageData] = useState<BootstrapPageData>();
	const bootstrapRequested = useRef(false);
	const applyApiContext = (context?: ApiContext) => {
		if (!context?.auth) throw new Error('认证上下文响应不完整');
		setAuth(context.auth);
		setNavigation(context.siteNavigation ?? []);
		setPageStatus(context.pageStatus);
	};
	const loadAuthContext = async (path: string) => {
		setContextError(false);
		const pathname = new URL(path, window.location.origin).pathname;
		const apiPath = initialData.bootstrapApiPath ?? `/api/home${initialData.apiSuffix}`;
		const endpoint = new URL(apiPath, window.location.origin);
		const includes = new Set((endpoint.searchParams.get('include') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
		includes.add('auth');
		includes.add('schema');
		includes.add('data');
		endpoint.searchParams.set('include', [...includes].join(','));
		const response = await commonApi.apiFetch(`${endpoint.pathname}${endpoint.search}`);
		const result = await response.json() as BootstrapResponse;
		applyApiContext(result.context);
		setBootstrapPageData({ pagePath: pathname, apiPath, response: result });
		setContextReady(true);
	};
	const bootstrapResponseFor = (apiPath: string) => (
		bootstrapPageData?.pagePath === location.pathname && bootstrapPageData.apiPath === apiPath
			? bootstrapPageData.response
			: undefined
	);
	const pages = useMemo(() => collectPageDefinitions(navigation), [navigation]);
	const authPages: PageDefinition[] = useMemo(() => (auth?.pages ?? []).map((page) => ({
		path: normalizePagePath(page.path, initialData.pageSuffix),
		component: 'sign',
		title: page.title,
		description: page.description ?? '',
		navigation: [],
		mode: page.mode,
		apiPath: page.apiPath,
		submitMethod: page.submitMethod,
		redirectPath: page.redirectPath,
	})), [auth]);
	const pageRenderers: Record<string, (page: PageDefinition) => React.ReactNode> = {
		home: () => {
			const apiPath = `/api/home${initialData.apiSuffix}`;
			return <HomePage commonApi={commonApi} apiSuffix={initialData.apiSuffix} initialData={bootstrapResponseFor(apiPath)?.home} />;
		},
		personalCenter: (page) => {
			const apiPath = `/api${page.path}${initialData.apiSuffix}`;
			return <PersonalCenter commonApi={commonApi} user={auth?.currentUser} title={page.title} initialResponse={bootstrapResponseFor(apiPath)} />;
		},
		sign: (page) => {
			if (!page.apiPath) return null;
			const apiPath = new URL(page.apiPath, window.location.origin);
			apiPath.searchParams.set('mode', page.mode ?? 'sign');
			const requestPath = `${apiPath.pathname}${apiPath.search}`;
			return <FormPage
				commonApi={commonApi}
				apiPath={requestPath}
				title={page.title}
				submitMethod={page.submitMethod}
				redirectOnFeedback
				onSaved={() => page.redirectPath}
				initialResponse={bootstrapResponseFor(requestPath)}
			/>;
		},
		panel: (page) => {
			const apiPath = `/api${page.dashboardPath ?? ''}${initialData.apiSuffix}`;
			return <Panel commonApi={commonApi} navigation={page.navigation} dashboardPath={page.dashboardPath} title={page.title}><Dashboard commonApi={commonApi} apiPath={apiPath} initialData={bootstrapResponseFor(apiPath)?.dashboard} /></Panel>;
		},
		panelRoot: (page) => <Navigate to={page.dashboardPath ? pageUrl(page.dashboardPath) : '/'} replace />,
		dashboard: (page) => {
			const apiPath = `/api${page.path}${initialData.apiSuffix}`;
			return <Panel commonApi={commonApi} navigation={page.navigation} dashboardPath={page.dashboardPath} title={page.title}><Dashboard commonApi={commonApi} apiPath={apiPath} initialData={bootstrapResponseFor(apiPath)?.dashboard} /></Panel>;
		},
		table: (page) => {
			const apiPath = `/api${page.path}${initialData.apiSuffix}`;
			return <Panel commonApi={commonApi} navigation={page.navigation} dashboardPath={page.dashboardPath} title={page.title}><TableCRUD key={page.path} commonApi={commonApi} resourcePath={page.path} initialResponse={bootstrapResponseFor(apiPath)} /></Panel>;
		},
		form: (page) => {
			const apiPath = `/api${page.path}${initialData.apiSuffix}`;
			return <Panel commonApi={commonApi} navigation={page.navigation} dashboardPath={page.dashboardPath} title={page.title}><FormPage
			commonApi={commonApi}
			apiPath={apiPath}
			 title={page.title}
			initialResponse={bootstrapResponseFor(apiPath)}
			onSaved={(values) => {
				const pageSuffix = typeof values.pageSuffix === 'string' ? values.pageSuffix : initialData.pageSuffix;
				return `${page.path}${pageSuffix}`;
			}}
		/></Panel>;
		},
		aliyunDescribeInstances: (page) => <Panel commonApi={commonApi} navigation={page.navigation} dashboardPath={page.dashboardPath} title={page.title}><DescribeInstances /></Panel>,
	};
	const routes = [...pages, ...authPages].flatMap((page) => {
		const render = pageRenderers[page.component];
		if (!render) return [];
		return pageRouteAliases(page).map((routePath) => ({ path: routePath, element: render(page) }));
	});
	routes.push({ path: pageUrl('/accounts/external/callback'), element: <ExternalCallback commonApi={commonApi} /> });
	// 兜底路由：路径不存在、未登录或无权访问时展示后端下发的提示。
	routes.push({ path: '*', element: <StatusPage commonApi={commonApi} apiSuffix={initialData.apiSuffix} pageSuffix={initialData.pageSuffix} pageStatus={pageStatus} /> });

	const isPopup = new URLSearchParams(location.search).get('popup') === '1';
	const [current, setCurrent] = useState(''); // 当前高亮的顶层菜单，无匹配时为空
	const items: MenuItem[] = useMemo(() => toMenuItems(navigation), [navigation]);

	useEffect(() => {
		// 设置 body 的 margin 为 0
		document.body.style.margin = '0';
		document.body.style.height = '100%';
		document.documentElement.style.height = '100%';
		const logicalPath = normalizePagePath(location.pathname, initialData.pageSuffix);
		// 只高亮真正匹配当前路径的顶层菜单；没有匹配项时不高亮。
		setCurrent(matchNavigationKey(items.map((item) => item && typeof item.key === 'string' ? item.key : ''), logicalPath));
		const page = [...pages, ...authPages].find((item) => item.path === logicalPath);
		const statusTitle = pageStatus?.path === location.pathname ? pageStatus.title : undefined;
		const pageTitle = page?.title ?? statusTitle;
		document.title = pageTitle ? `${pageTitle} | ${initialData.siteName}` : initialData.siteName;
	}, [authPages, items, location.pathname, pageStatus, pages]);

	const onClick: MenuProps['onClick'] = (e) => {
		console.log('click ', e);
		setCurrent(e.key);

		// 对非外部链接的菜单项手动导航
		if (!e.keyPath.some((key) => key === 'external')) {
			navigate(pageUrl(e.key));
		}
	};
	useEffect(() => {
		if (initialData.bootstrapMode !== 'api' || bootstrapRequested.current) return;
		bootstrapRequested.current = true;
		void loadAuthContext(location.pathname).catch(() => {
			setContextError(true);
			setContextReady(true);
		});
	}, [commonApi, location.pathname]);

	useEffect(() => {
		// HTML 启动时携带的页面响应只属于首次打开的路径。离开该路径后立即释放，
		// 后续返回必须重新请求接口，不能把一次性启动响应当作页面缓存重复使用。
		if (bootstrapPageData && bootstrapPageData.pagePath !== location.pathname) setBootstrapPageData(undefined);
	}, [bootstrapPageData, location.pathname]);

	useEffect(() => {
		const onApiNavigation = (event: Event) => {
			const detail = (event as CustomEvent<ApiNavigationEventDetail>).detail;
			const next = detail?.next;
			// 没有下一步动作时只更新认证状态：改完自己的昵称，右上角要变，页面不该动。
			// 只取 auth 一项——这类响应不带导航树和页面状态，整份套上去会把它们清空。
			if (!next) { if (detail?.context?.auth) setAuth(detail.context.auth); return; }
			if (next.action !== 'navigate' || !next.refreshAuth) return;
			try {
				applyApiContext(detail.context);
				navigate(next.path);
			} catch {
				// 响应没有携带认证上下文时，完整页面导航重新建立状态。
				window.location.assign(next.path);
			}
		};
		window.addEventListener(apiNavigationEvent, onApiNavigation);
		return () => window.removeEventListener(apiNavigationEvent, onApiNavigation);
	}, [commonApi, navigate]);
	if (!contextReady) return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: '#666' }}>正在加载页面…</div>;
	if (contextError) return <Result status="error" title="页面配置加载失败" subTitle="请刷新页面重试。" />;
	return (
		<Layout style={{ height: '100%' }}>
			{!isPopup && <Layout.Header style={{ height: 48, minHeight: 48, lineHeight: '48px', padding: '0 24px', display: 'flex', alignItems: 'center', background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
				<Menu
					onClick={onClick}
					selectedKeys={[current]}
					mode="horizontal"
					items={items}
					style={{ flex: 1, minWidth: 0, borderBottom: 0 }}
				/>
				<Space size={4}><AuthActions auth={auth} commonApi={commonApi} apiSuffix={initialData.apiSuffix} pageSuffix={initialData.pageSuffix} /></Space>
			</Layout.Header>}
			<Content>
				<Routes>
					{routes.map((route) => (
						<Route key={route.path} path={route.path} element={route.element} />
					))}
				</Routes>
			</Content>
		</Layout>
	);
};

import { useCommonApi } from '@/utils/common/api.js'

const AppRoot = () => {
	const [commonApi, contextHolder] = useCommonApi();
	return (
		<Router>
			{contextHolder}
			<App commonApi={commonApi} />
		</Router>
	);
};

export default AppRoot;
