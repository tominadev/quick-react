import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const projectDirectory = resolve(import.meta.dirname, '..');

/**
 * **表格结构只有第一帧那一次机会。**
 *
 * 前端只从第一次响应里取结构（`include=schema,data`），之后改用 `include=data`，
 * 公共响应层会把 `option` 整个剥掉（见 `selectTableResponse`）。而第一次请求必然
 * 不带那些「服务端给默认值」的查询参数——默认值就在它即将收到的这份结构里。
 *
 * 于是「参数还没到」那一支下发什么，就是这一页从头到尾用的全部结构。少一个 toolbar，
 * 按钮就再也不会出现；而界面上没有任何报错，只是那个功能像从来没做过一样。对象存储的
 * 「上传」正是这样消失的：它只写在「已选绑定」那一支里。
 *
 * 出路有两条，满足一条即可：
 *
 * 1. 查询字段声明 `reloadSchema: true`——值变化时前端重置 `tableSchemaLoaded`，
 *    下一次请求重新带上 `schema`。结构确实随这个值变化时用它（数据管理换数据表）。
 * 2. 整个路由只有一份 `option`——结构压根不随参数变化，那就别写成两份。
 *    对象存储的对象列表属于这种：换哪个绑定，列和动作都一模一样。
 *
 * 这里按源码扫，不跑接口：要守的是「有没有第二份结构」这件事本身，它在源码里就看得出来，
 * 而跑接口要先有登录、有云凭据、有真实 Bucket，任何一样缺席这个检查就静默失效了。
 */
const exempt = new Map([
	// 暂无豁免。确实需要时在这里登记路由和理由，别把断言注释掉。
]);

const walk = async (directory) => {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...await walk(full));
		else if (entry.name.endsWith('.mts')) found.push(full);
	}
	return found;
};

/**
 * 从 `at` 往外找到**最内层**那个包住它的对象字面量。
 *
 * 往回数括号找到开头，再往前数括号配平找到结尾。查询字段常常带着 `options: [...]`
 * 和嵌套对象，只截到第一个 `}` 会把 `reloadSchema` 漏在外面，判成缺失。
 */
const enclosingLiteral = (source, at) => {
	let depth = 0;
	let start = -1;
	for (let index = at; index >= 0; index -= 1) {
		if (source[index] === '}') depth += 1;
		else if (source[index] === '{') {
			if (depth === 0) { start = index; break; }
			depth -= 1;
		}
	}
	if (start < 0) return '';
	let balance = 0;
	for (let index = start; index < source.length; index += 1) {
		if (source[index] === '{') balance += 1;
		else if (source[index] === '}') {
			balance -= 1;
			if (balance === 0) return source.slice(start, index + 1);
		}
	}
	return source.slice(start);
};

const routesDirectory = resolve(projectDirectory, 'server/routes');
const routes = [];
for (const file of (await walk(routesDirectory)).sort()) {
	routes.push([file.slice(routesDirectory.length + 1), await readFile(file, 'utf8')]);
}
assert.ok(routes.length >= 20, `路由文件太少，扫描逻辑可能失效：${routes.length}`);

const problems = [];
let checked = 0;
for (const [route, source] of routes) {
	// 结构分几份看的是**写死的那种** `option: {`；抽成一个变量再两处引用的，本来就是同一份。
	const inlineOptions = [...source.matchAll(/option:\s*\{/g)].length;
	for (const match of source.matchAll(/defaultValue:/g)) {
		const literal = enclosingLiteral(source, match.index);
		// 只管查询字段：它带 `label`，表格列带的是 `title`，设置页的表单项用 `name` 不用 `dataIndex`。
		if (!literal.includes('dataIndex:') || !literal.includes('label:')) continue;
		checked += 1;
		if (exempt.has(route)) continue;
		if (/reloadSchema:\s*true/.test(literal)) continue;
		if (inlineOptions <= 1) continue;
		const field = literal.match(/dataIndex:\s*'([^']+)'/)?.[1] ?? '（未知字段）';
		problems.push(`${route}：查询字段 ${field} 有服务端默认值，但这个路由写了 ${inlineOptions} 份 option。`
			+ `\n    第一次请求不会带 ${field}（默认值就在它要收的这份结构里），拿到的是"参数还没到"那一份，之后再不会更新。`
			+ `\n    要么给 ${field} 加 reloadSchema: true，要么把 option 抽成一份两处共用。`);
	}
}

assert.ok(checked >= 3, `带默认值的查询字段太少，扫描逻辑可能失效：${checked}`);
assert.deepEqual(problems, [], `以下表格的结构可能只有"参数还没到"的那一份能到前端：\n  ${problems.join('\n  ')}`);
console.log(`table schema once test passed (${checked} 个带默认值的查询字段)`);
