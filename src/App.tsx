import type React from 'react';
import type { MenuProps } from 'antd';
import type { CommonApi } from '@/utils/common/api.js';
import type { InitialData } from '@shared/types/initial-data.mjs';
import type { AuthState } from '@shared/types/initial-data.mjs';
import type { ApiNextAction } from '@shared/types/api-response.mjs';
import type { NavigationItem } from '@shared/types/navigation.mjs';
import { collectPageDefinitions, matchNavigationKey, stripPageSuffix, type NavigationPageDefinition } from '@shared/navigation-tree.mjs';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
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
import { apiNavigationEvent } from '@/utils/common/response-action.js';
const { Content } = Layout;

type MenuItem = Required<MenuProps>['items'][number];

const serverData = (window as Window & { __INITIAL_DATA__?: InitialData }).__INITIAL_DATA__;
const initialData = serverData ?? { apiSuffix: '', pageSuffix: '', siteName: 'Quick React', siteNavigation: [] };
const pageUrl = (path: string) => path === '/' ? path : `${path}${initialData.pageSuffix}`;

type PageDefinition = NavigationPageDefinition;

const iconComponents = {
	mail: <MailOutlined />,
	appstore: <AppstoreOutlined />,
};
const toMenuItems = (menu: NavigationItem[], onTitleClick?: (key: string) => void): MenuItem[] => menu.filter((item) => !item.hidden).map((item) => ({
	label: item.label,
	key: item.key,
	icon: iconComponents[item.icon as keyof typeof iconComponents],
	children: item.children && item.dropdown !== false ? toMenuItems(item.children, onTitleClick) : undefined,
	...(item.children && onTitleClick ? { onTitleClick: () => onTitleClick(item.key) } : {}),
}));


type AppType = {
	commonApi: CommonApi;
};

const App = ({ commonApi }: AppType) => {
	const location = useLocation();
	const navigate = useNavigate();
	const [contextReady, setContextReady] = useState(initialData.bootstrapMode !== 'api');
	const [contextError, setContextError] = useState(false);
	const [pageStatus, setPageStatus] = useState(initialData.pageStatus);
	const [auth, setAuth] = useState<AuthState | undefined>(initialData.auth);
	const [navigation, setNavigation] = useState(initialData.siteNavigation);
	const bootstrapRequested = useRef(false);
	const loadAuthContext = async (path: string) => {
		setContextError(false);
		const pathname = new URL(path, window.location.origin).pathname;
		const response = await commonApi.apiFetch(`/api/auth${initialData.apiSuffix}?path=${encodeURIComponent(pathname)}`);
		const result = await response.json() as { auth?: AuthState; siteNavigation?: NavigationItem[]; pageStatus?: InitialData['pageStatus'] };
		setAuth(result.auth);
		if (result.siteNavigation) setNavigation(result.siteNavigation);
		setPageStatus(result.pageStatus);
		setContextReady(true);
	};
	const pages = useMemo(() => collectPageDefinitions(navigation), [navigation]);
	const authPages: PageDefinition[] = useMemo(() => (auth?.pages ?? []).map((page) => ({
		path: page.path,
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
		home: () => <HomePage commonApi={commonApi} apiSuffix={initialData.apiSuffix} />,
		personalCenter: (page) => <PersonalCenter commonApi={commonApi} user={auth?.currentUser} title={page.title} />,
		sign: (page) => {
			return <FormPage
				commonApi={commonApi}
				apiPath={`${page.apiPath}?mode=${page.mode}`}
				title={page.title}
				submitMethod={page.submitMethod}
				redirectOnFeedback
				onSaved={() => page.redirectPath}
			/>;
		},
		panel: (page) => <Panel commonApi={commonApi} navigation={page.navigation} dashboardPath={page.dashboardPath} title={page.title}><Dashboard commonApi={commonApi} apiPath={`/api${page.dashboardPath ?? ''}${initialData.apiSuffix}`} /></Panel>,
		dashboard: (page) => <Panel commonApi={commonApi} navigation={page.navigation} dashboardPath={page.dashboardPath} title={page.title}><Dashboard commonApi={commonApi} apiPath={`/api${page.dashboardPath ?? ''}${initialData.apiSuffix}`} /></Panel>,
		table: (page) => <Panel commonApi={commonApi} navigation={page.navigation} dashboardPath={page.dashboardPath} title={page.title}><TableCRUD key={page.path} commonApi={commonApi} resourcePath={page.path} /></Panel>,
		form: (page) => <Panel commonApi={commonApi} navigation={page.navigation} dashboardPath={page.dashboardPath} title={page.title}><FormPage
			commonApi={commonApi}
			apiPath={`/api${page.path}${initialData.apiSuffix}`}
			 title={page.title}
			onSaved={(values) => {
				const pageSuffix = typeof values.pageSuffix === 'string' ? values.pageSuffix : initialData.pageSuffix;
				return `${page.path}${pageSuffix}`;
			}}
		/></Panel>,
		aliyunDescribeInstances: (page) => <Panel commonApi={commonApi} navigation={page.navigation} dashboardPath={page.dashboardPath} title={page.title}><DescribeInstances /></Panel>,
	};
	const routes = [...pages, ...authPages].flatMap((page) => {
		const render = pageRenderers[page.component];
		if (!render) return [];
		const routePath = page.component === 'sign' ? page.path : pageUrl(page.path);
		return [{ path: routePath, element: render(page) }];
	});
	routes.push({ path: pageUrl('/accounts/external/callback'), element: <ExternalCallback commonApi={commonApi} /> });
	// 兜底路由：路径不存在、未登录或无权访问时展示后端下发的提示。
	routes.push({ path: '*', element: <StatusPage commonApi={commonApi} apiSuffix={initialData.apiSuffix} pageSuffix={initialData.pageSuffix} pageStatus={pageStatus} /> });

	const isPopup = new URLSearchParams(location.search).get('popup') === '1';
	const [current, setCurrent] = useState(''); // 当前高亮的顶层菜单，无匹配时为空
	const items: MenuItem[] = useMemo(() => toMenuItems(navigation, (key) => navigate(pageUrl(key))), [navigate, navigation]);

	useEffect(() => {
		// 设置 body 的 margin 为 0
		document.body.style.margin = '0';
		document.body.style.height = '100%';
		document.documentElement.style.height = '100%';
		const logicalPath = stripPageSuffix(location.pathname, initialData.pageSuffix);
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
	const memoizedRoutes = useMemo(() => routes, [auth, navigation]);

	useEffect(() => {
		if (initialData.bootstrapMode !== 'api' || bootstrapRequested.current) return;
		bootstrapRequested.current = true;
		void loadAuthContext(location.pathname).catch(() => {
			setContextError(true);
			setContextReady(true);
		});
	}, [commonApi, location.pathname]);

	useEffect(() => {
		const onApiNavigation = (event: Event) => {
			const next = (event as CustomEvent<ApiNextAction>).detail;
			if (!next || next.action !== 'navigate' || !next.refreshAuth) return;
			void (async () => {
				try {
					await loadAuthContext(next.path);
					navigate(next.path);
				} catch {
					// 认证状态接口不可用时仍执行后端给出的目标，完整页面导航会重新建立状态。
					window.location.assign(next.path);
				}
			})();
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
					{memoizedRoutes.map((route) => (
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
