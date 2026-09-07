import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter as Router, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Button, ErrorBlock, List, NavBar, Result, TabBar } from 'antd-mobile';
import type { AuthState, InitialData } from '@shared/types/initial-data.mjs';
import type { ApiContext } from '@shared/types/api-response.mjs';
import type { NavigationItem } from '@shared/types/navigation.mjs';
import { collectPageDefinitions, normalizePagePath, stripPageSuffix, type NavigationPageDefinition } from '@shared/navigation-tree.mjs';
import { apiNavigationEvent, planApiNavigation, type ApiNavigationEventDetail } from '@clients/browser/response-action.js';
import { useCommonApi } from './common-api.js';
import MobileTable from './components/MobileTable.js';
import MobileForm from './components/MobileForm.js';

/**
 * 手机版应用壳。
 *
 * **与桌面版共用的是协议，不是组件**：导航树、页面定义、API 客户端、表格协议全部来自
 * `@shared` 与 `@clients/browser`，这一层只决定长什么样——桌面版是左侧菜单加表格，
 * 手机上换成底部标签栏加卡片列表。
 *
 * 后端一个字都不用改：它下发的是「有哪些页面、每页有哪些列、哪些动作对哪一行可见」，
 * 至于渲染成 `<table>` 还是一叠卡片，本来就是前端的事。
 */
const serverData = (window as Window & { __INITIAL_DATA__?: InitialData }).__INITIAL_DATA__;
const initialData = serverData ?? { apiSuffix: '', pageSuffix: '', siteName: 'Quick React', siteNavigation: [] };
const pageUrl = (path: string) => path === '/' ? path : `${path}${initialData.pageSuffix}`;

type PageDefinition = NavigationPageDefinition;

/** 底部标签栏只放**顶层**入口：手机上没有位置铺开一棵树，深的层级靠页面内跳转。 */
const topLevelEntries = (navigation: NavigationItem[]) => navigation
	.filter((item) => item.key === '/' || item.dashboardPath || (item.children?.length ?? 0) > 0)
	.slice(0, 5);

const Shell = ({ navigation, children }: { navigation: NavigationItem[]; children: React.ReactNode }) => {
	const navigate = useNavigate();
	const location = useLocation();
	const entries = useMemo(() => topLevelEntries(navigation), [navigation]);
	const current = entries.find((item) => location.pathname.startsWith(stripPageSuffix(item.key, initialData.pageSuffix)))?.key ?? entries[0]?.key;
	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
			<NavBar back={location.pathname === '/' ? null : '返回'} onBack={() => navigate(-1)}>{initialData.siteName}</NavBar>
			<div style={{ flex: 1, overflow: 'auto', background: '#f5f5f5' }}>{children}</div>
			{entries.length > 1 && (
				<TabBar activeKey={current} onChange={(key) => navigate(pageUrl(navigation.find((item) => item.key === key)?.dashboardPath ?? key))}>
					{entries.map((item) => <TabBar.Item key={item.key} title={item.label} />)}
				</TabBar>
			)}
		</div>
	);
};

/** 页面内的子菜单：手机上把下一层做成一张可点的列表，而不是把整棵树塞进侧栏。 */
const SectionList = ({ item }: { item: NavigationItem }) => {
	const navigate = useNavigate();
	return (
		<List header={item.description ?? item.title ?? item.label}>
			{(item.children ?? []).map((child) => (
				<List.Item key={child.key} description={child.description} onClick={() => navigate(pageUrl(child.key))}>{child.label}</List.Item>
			))}
		</List>
	);
};

export const App = () => {
	const [commonApi, contextHolder] = useCommonApi();
	const [navigation, setNavigation] = useState<NavigationItem[]>(initialData.siteNavigation ?? []);
	const [auth, setAuth] = useState<AuthState | undefined>(initialData.auth);
	const pages = useMemo(() => collectPageDefinitions(navigation), [navigation]);
	/**
	 * 登录、注册这些页面来自**认证上下文**，不在导航树里——它们是否存在取决于站点开没开
	 * 注册、绑没绑 Accounts，那是服务端按当前身份算出来的。
	 */
	const authPages = useMemo(() => (auth?.pages ?? []).map((page) => ({
		path: normalizePagePath(page.path, initialData.pageSuffix),
		title: page.title,
		apiPath: page.apiPath,
		submitMethod: page.submitMethod,
		mode: page.mode,
	})), [auth]);

	// 认证上下文由响应层统一下发（与桌面版同一条路径），这里只管把导航换掉。
	useEffect(() => {
		const onNavigation = (event: Event) => {
			const detail = (event as CustomEvent<ApiNavigationEventDetail>).detail;
			const context = detail?.context as ApiContext | undefined;
			if (context?.siteNavigation) setNavigation(context.siteNavigation);
			if (context?.auth) setAuth(context.auth as AuthState);
		};
		window.addEventListener(apiNavigationEvent, onNavigation);
		return () => window.removeEventListener(apiNavigationEvent, onNavigation);
	}, []);

	const renderPage = (page: PageDefinition) => {
		// 分组节点（有子页、自己不渲染内容）在手机上变成一张列表。
		const node = page.navigation?.find((item) => item.key === page.path);
		if (page.component === 'table') return <MobileTable commonApi={commonApi} resourcePath={page.path} title={page.title} />;
		// 个人中心与设置页在协议上都是 formPage，同一个组件渲染。
		if (page.component === 'form' || page.component === 'personalCenter') return <MobileForm commonApi={commonApi} apiPath={page.path} title={page.title} submitMethod="PUT" />;
		if (node?.children?.length) return <SectionList item={node} />;
		return <Result status="info" title={page.title ?? '这一页还没有手机版'} description="桌面版里有完整功能，手机版正在逐步补齐。" />;
	};

	return (
		<Router>
			{contextHolder}
			<Shell navigation={navigation}>
				<Routes>
					{pages.map((page) => (
						<Route key={page.path} path={normalizePagePath(pageUrl(page.path))} element={renderPage(page)} />
					))}
					{authPages.map((page) => (
						<Route key={page.path} path={page.path} element={
							<MobileForm commonApi={commonApi} apiPath={page.apiPath.replace(/^\/api/, '').replace(new RegExp(`${initialData.apiSuffix}$`), '')} title={page.title} submitMethod={page.submitMethod === 'PUT' ? 'PUT' : 'POST'} />
						} />
					))}
					<Route path="*" element={<ErrorBlock status="empty" title="页面不存在" description={<Button color="primary" fill="none" onClick={() => { window.location.href = '/'; }}>回首页</Button>} />} />
				</Routes>
			</Shell>
		</Router>
	);
};

export default App;
