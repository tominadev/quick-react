import type { MenuNode } from '@server/routes/base/navigation.mjs';

const navigation: MenuNode[] = [{
	label: '管理后台', key: 'panel/admin', icon: 'appstore', dashboardPath: '/panel/admin/pve/dashboard', roles: ['platform_admin', 'tenant_admin', 'branch_admin'],
	children: [{
		label: 'PVE', key: 'pve', icon: 'appstore', navigationGroup: 'pve', dropdown: false, title: 'PVE 管理', description: '管理 PVE 地区、节点、实例规格和虚拟机', roles: ['platform_admin', 'tenant_admin', 'branch_admin'],
		children: [
		{ label: '仪表盘', key: 'dashboard', icon: 'mail', component: 'dashboard', title: 'PVE 管理仪表盘', description: '查看 PVE 资源概览' },
		{ label: '地区', key: 'regions', icon: 'appstore', component: 'table', title: 'PVE 地区', description: '管理 PVE 资源地区' },
		{ label: '节点', key: 'nodes', icon: 'appstore', component: 'table', title: 'PVE 节点', description: '管理 PVE 主机和集群节点' },
		{ label: '实例规格', key: 'instance-flavors', icon: 'appstore', component: 'table', title: '实例规格', description: '管理 CPU 和内存组合' },
		{ label: 'VM', key: 'vms', icon: 'appstore', component: 'table', title: 'PVE VM', description: '管理 PVE 虚拟机实例' },
		],
	}],
}];

export default navigation;
