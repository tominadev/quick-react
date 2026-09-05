import type React from 'react';
import type { MenuProps } from 'antd';
import type { CommonApi } from '@/utils/common/api.js';
import type { NavigationItem } from '@shared/types/navigation.mjs';
import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
	AppstoreOutlined,
	MailOutlined,
	MenuFoldOutlined,
	MenuUnfoldOutlined,
} from '@ant-design/icons';
import { Breadcrumb, Layout, Menu, theme } from 'antd';
import { findNavigationTrail, navigationBreadcrumb, normalizePagePath } from '@shared/navigation-tree.mjs';
const { Header, Content, Footer, Sider } = Layout;

// 定义菜单项
type MenuItem = Required<MenuProps>['items'][number];

type InitialMenuItem = NavigationItem;

const initialData = (window as Window & {
	__INITIAL_DATA__?: { apiSuffix?: string; footer?: string };
}).__INITIAL_DATA__;
const apiSuffix = initialData?.apiSuffix ?? '';
const pageSuffix = (window as Window & { __INITIAL_DATA__?: { pageSuffix?: string } }).__INITIAL_DATA__?.pageSuffix ?? '';
const iconComponents = {
	mail: <MailOutlined />,
	appstore: <AppstoreOutlined />,
};
/**
 * 有子菜单的项**只展开，不跳转**。
 *
 * antd 的 SubMenu 标题点一下会同时触发展开和 onTitleClick，于是「想展开 base 看看有
 * 哪些页面」变成了「被拽去 base 的仪表盘」。而仪表盘本来就是这些分组的第一个子项
 * （`/panel/admin/base/dashboard`），标题上再挂一个入口只是重复，代价却是展开不能用了。
 */
const toMenuItems = (menu: InitialMenuItem[], depth = 0): MenuItem[] => menu.filter((item) => !item.hidden).flatMap((item, index) => {
	const children = item.children ? toMenuItems(item.children, depth + 1) : undefined;
	/**
	 * **最顶层不折叠，用分隔线隔开。**
	 *
	 * 顶层那几项（基础管理、全局管理、Passport、PVE）是「在哪一块」，不是一层菜单：
	 * 折叠起来的话，每次进来只有当前模块是展开的，想看看别的模块有什么得先点开——
	 * 而那一下点开还什么都不做（有子菜单的项只展开不跳转）。用分组标题加一条分隔线，
	 * 整张侧栏一眼看全，也省掉了这一次无谓的点击。
	 */
	if (depth === 0 && children?.length) {
		const group: MenuItem[] = [{ type: 'group', key: item.key, label: item.label, children }];
		return index > 0 ? [{ type: 'divider' } as MenuItem, ...group] : group;
	}
	const entry: MenuItem[] = [{
		label: item.label,
		key: item.key,
		icon: iconComponents[item.icon as keyof typeof iconComponents],
		children,
	}];
	return entry;
});
const pageUrl = (path: string) => path === '/' ? path : `${path}${pageSuffix}`;


type AppType = {
	commonApi: CommonApi;
	children?: React.ReactNode;
	navigation?: InitialMenuItem[];
	dashboardPath?: string;
	title?: string;
};

function AppRouter({ commonApi, children, navigation = [], dashboardPath, title }: AppType) {
	const dashboardApiPath = dashboardPath ? `/api${dashboardPath}${apiSuffix}` : '';
	const location = useLocation(); // 获取当前 URL 路径
	const getMenuPath = (pathname: string) => {
		const path = normalizePagePath(pathname, pageSuffix);
		return findNavigationTrail(navigation, path).length ? path : dashboardPath ?? path;
	};
	const [current, setCurrent] = useState(() => getMenuPath(location.pathname)); // 同步选中状态
	const [openKeys, setOpenKeys] = useState<string[]>(() => findNavigationTrail(navigation, getMenuPath(location.pathname)).slice(0, -1).map((item) => item.key));
	const navigate = useNavigate();
	// 菜单结构只随导航树变，不随选中项变；每次渲染重建一遍纯属浪费。
	const items: MenuItem[] = useMemo(() => toMenuItems(navigation), [navigation]);

	const [collapsed, setCollapsed] = useState(false);
	const {
		token: { colorBgContainer },
	} = theme.useToken();
	useEffect(() => {
		const nextLogicalPath = normalizePagePath(location.pathname, pageSuffix);
		const menuPath = getMenuPath(nextLogicalPath);
		setCurrent(menuPath); // URL 变化时同步菜单高亮
		setOpenKeys(findNavigationTrail(navigation, menuPath).slice(0, -1).map((item) => item.key));
	}, [location.pathname]);

	/**
	 * 面包屑走**整条菜单路径**：管理后台 / 基础管理 / 系统设置 / 站点设置。
	 *
	 * 原先是「页面标题 + 当前菜单项」两截，而这两个值在绝大多数页面上是同一个字符串
	 * （导航里 label 和 title 都写作「站点设置」），于是面包屑读起来是「站点设置 / 站点设置」；
	 * 表单页的 Card 标题还会再写一遍，同一个词一屏三次，却始终不告诉人这一页挂在哪个分组下——
	 * 而那正是面包屑唯一要回答的问题。
	 *
	 * 页面标题不进面包屑：表单页自己用 Card 标题显示，浏览器标签页也有。
	 * 菜单里没有的页面（个人中心一类 hidden 项）没有路径可走，才回落到页面标题。
	 */
	const breadcrumbItems = useMemo(() => {
		const labels = navigationBreadcrumb(navigation, current);
		return labels.length ? labels.map((label) => ({ title: label })) : title ? [{ title }] : [];
	}, [navigation, current, title]);

	const onClick: MenuProps['onClick'] = (e) => {
		console.log('click ', e);
		setCurrent(e.key);

		// 对非外部链接的菜单项手动导航
		if (!e.keyPath.some((key) => key === 'external')) {
			navigate(pageUrl(e.key));
		}
	};
	return (
		<Layout style={{ height: '100%' }}>
			<Sider
				theme="dark"
				collapsible
				collapsed={collapsed}
				onCollapse={(value) => setCollapsed(value)}
			>
				<div className="demo-logo-vertical" />
				<Menu
					onClick={onClick}
					selectedKeys={[current]}
					openKeys={openKeys}
					onOpenChange={(keys) => setOpenKeys(keys as string[])}
					mode="inline"
					theme="dark"
					inlineCollapsed={collapsed}
					inlineIndent={12}
					items={items}
				/>
			</Sider>
			<Layout>
				<Header style={{ height: 48, padding: '0 24px', lineHeight: '48px', display: 'flex', alignItems: 'center', background: colorBgContainer }}>
					<Breadcrumb items={breadcrumbItems} />
				</Header>
				<Content style={{
					margin: '8px',
					height: '100%',
					overflowY: 'scroll',
				}}>
					{children}
				</Content>
				{initialData?.footer ? <Footer style={{ height: '30px', padding: '2px', textAlign: 'center', overflow: 'hidden' }}>
					{initialData.footer}
				</Footer> : null}
			</Layout>
		</Layout>
	);
}

export default AppRouter;
