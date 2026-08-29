import type { MenuNode } from '@server/routes/base/navigation.mjs';

const navigation: MenuNode[] = [{
	label: '管理后台', key: 'panel/admin', icon: 'appstore', component: 'panel', title: '管理后台', description: 'PVE 管理后台', roles: ['admin'],
	children: [{
		label: 'PVE', key: 'pve', icon: 'appstore', dropdown: false, roles: ['admin'],
		children: [
		{ label: '地区', key: 'regions', icon: 'appstore', component: 'table', title: 'PVE 地区', description: '管理 PVE 资源地区' },
		{ label: '节点', key: 'nodes', icon: 'appstore', component: 'table', title: 'PVE 节点', description: '管理 PVE 主机和集群节点' },
		{ label: '实例规格', key: 'instance-flavors', icon: 'appstore', component: 'table', title: '实例规格', description: '管理 CPU 和内存组合' },
		{ label: 'VM', key: 'vms', icon: 'appstore', component: 'table', title: 'PVE VM', description: '管理 PVE 虚拟机实例' },
		],
	}],
}];

export default navigation;
