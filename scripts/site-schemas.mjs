import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `prisma/` 下有哪些站点 schema。
 *
 * 这里不写死站点名单：名单写死过一次，新增 `prisma/loki.prisma` 之后迁移生成器照着旧名单
 * 跑完，打印的是「Schema 未发生结构变化」——既没生成迁移，看起来又像成功，
 * 要到运行时报「表不存在」才会发现。目录里有什么就是什么，加站点不用记得改这里。
 *
 * global 和 base 排在前面：它们建的是站点注册表和公共基础表，别的站点建在其后更自然。
 * 其余按文件名排序，保证每次执行的顺序一致。
 */
const PREFERRED_ORDER = ['global', 'base', 'passport'];

export const listSiteSchemas = async (projectDirectory) => {
	const names = (await readdir(join(projectDirectory, 'prisma')))
		.filter((file) => file.endsWith('.prisma'))
		.map((file) => file.replace(/\.prisma$/, ''))
		.sort();
	const preferred = PREFERRED_ORDER.filter((site) => names.includes(site));
	return [...preferred, ...names.filter((site) => !preferred.includes(site))];
};
