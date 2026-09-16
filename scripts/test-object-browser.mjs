import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/**
 * 对象存储浏览器：按目录浏览、进得去也退得回、下载地址签得出来。
 *
 * 对着一个只认 ListObjectsV2 的假 S3 跑，不连真实云服务：要验的是**服务端发出去的查询**
 * 与**回来之后怎么组织成一页**，那两头都在本地。
 *
 * 这里守的是一个真发作过的缺陷：list 请求没有带 `delimiter`，而 S3 只有收到它才会把同一层
 * 的对象折成 `CommonPrefixes`。不带就是把整个 Bucket 扁平列出来，浏览器里看到的是一长串
 * 带完整路径的 key，一层也点不进去——解析 `CommonPrefixes` 的代码一直都在，只是从来没有
 * 东西可解析。
 */
const files = [
	'shortcuts/mac-studio-01/20260906/1-a.shortcut',
	'shortcuts/mac-studio-01/20260906/2-b.shortcut',
	'shortcuts/mac-pro/20260905/3-c.shortcut',
	'avatars/u1.png',
	'中文 文件.txt',
];
const received = [];
const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://localhost');
	received.push(Object.fromEntries(url.searchParams));
	if (url.searchParams.get('list-type') !== '2') { res.writeHead(200); res.end('ok'); return; }
	const prefix = url.searchParams.get('prefix') ?? '';
	const delimiter = url.searchParams.get('delimiter') ?? '';
	let keys = files.filter((file) => file.startsWith(prefix));
	const directories = new Set();
	if (delimiter) {
		keys = keys.filter((file) => {
			const rest = file.slice(prefix.length);
			const at = rest.indexOf(delimiter);
			if (at < 0) return true;
			directories.add(prefix + rest.slice(0, at + 1));
			return false;
		});
	}
	const xml = `<?xml version="1.0"?><ListBucketResult>`
		+ [...directories].map((item) => `<CommonPrefixes><Prefix>${item}</Prefix></CommonPrefixes>`).join('')
		+ keys.map((key) => `<Contents><Key>${key}</Key><Size>123</Size><LastModified>2026-09-06T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag></Contents>`).join('')
		+ `<IsTruncated>false</IsTruncated></ListBucketResult>`;
	res.writeHead(200, { 'content-type': 'application/xml' });
	res.end(xml);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-object-browser-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';
try {
	const { app, runMaintenanceAction } = await import(`../dist/server.mjs?object-browser=${Date.now()}`);
	await runMaintenanceAction('restore-admin', { user_name: 'objadmin', password: 'object-password-1' });
	const seed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const now = Date.now();
	seed.prepare("INSERT INTO global_cloud_credentials (key, id, title, provider, access_key_id, access_key_secret, status, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 91, 'mock', 'aliyun', 'AKIAtest', 'secrettest', 'enabled', ?, ?)").run(now, now);
	seed.prepare(`INSERT INTO global_cloud_object_storage_buckets (key, id, cloud_credential_id, bucket, endpoint, region, path_style, status, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 92, 91, 'mockbucket', 'http://127.0.0.1:${port}', 'cn-test', 1, 'enabled', ?, ?)`).run(now, now);
	seed.prepare(`INSERT INTO global_cloud_object_storage_bindings (key, id, site_key, bucket_id, purposes, key_prefix, status, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 93, 'base', 92, '["uploads"]', '', 'enabled', ?, ?)`).run(now, now);
	seed.close();
	const headers = {
		'content-type': 'application/json',
		'x-device-key': '00000000000040008000000000000001',
		'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: 'a', audio_cyrb53: 'b' }),
	};
	const login = await app.request('http://localhost/api/sign.php', { method: 'POST', headers, body: JSON.stringify({ user_name: 'objadmin', password: 'object-password-1' }) });
	const h = { ...headers, cookie: login.headers.get('set-cookie')?.split(';')[0] };
	const path = '/api/panel/admin/global/cloud/object-storage/objects.php';
	const browse = async (prefix) => (await (await app.request(`http://localhost${path}?include=schema,data&binding_id=93${prefix === undefined ? '' : `&prefix=${encodeURIComponent(prefix)}`}`, { headers: h })).json()).table;

	// 还没选绑定时也要下发完整的列：前端只在第一次响应里取结构，之后只请求数据，
	// 那时回一个空 columns 就再也没机会替换——页面上只剩一列复选框。
	const empty = (await (await app.request(`http://localhost${path}?include=schema,data`, { headers: h })).json()).table;
	assert.deepEqual(empty.columns.map((column) => column.dataIndex), ['name', 'size', 'lastModified', 'etag'], '没选绑定时也要有列定义');
	assert.deepEqual(empty.dataSource, []);

	// 动作和列一样，也只有第一次响应这一次机会，而第一次请求必然还没带 binding_id——
	// 绑定的默认值就在这份结构里。上传只在「选了绑定」那一支下发过，于是浏览器里那个
	// 「上传」按钮从来没出现过：拿到它的那次响应，前端已经不再读结构了。
	assert.deepEqual(empty.option.actions.toolbar.map((action) => action.key), ['upload'], '没选绑定时也要下发上传按钮');
	assert.deepEqual(empty.option.actions.row.map((action) => action.key), ['enter', 'download', 'delete'], '没选绑定时也要下发行动作');
	// 而第二次请求只要数据，option 会被整个剥掉——这就是"以后再补"为什么不成立。
	const dataOnly = (await (await app.request(`http://localhost${path}?include=data&binding_id=93`, { headers: h })).json()).table;
	assert.equal(dataOnly.option, undefined, '只请求数据时不会再下发结构');
	assert.ok(Array.isArray(dataOnly.dataSource));

	const root = await browse();
	assert.equal(received.at(-1).delimiter, '/', 'list 必须带 delimiter，否则根本没有目录这回事');
	assert.deepEqual(root.dataSource.map((row) => row.name), ['shortcuts/', 'avatars/', '中文 文件.txt'], '根目录是两个目录加一个文件，不是五个带全路径的 key');
	assert.deepEqual(root.dataSource.map((row) => row.is_prefix), ['1', '1', '0']);
	// 目录只能进，文件才谈得上下载与删除；一行上永远只出现其中一组。
	const actions = Object.fromEntries(root.option.actions.row.map((action) => [action.key, action]));
	assert.deepEqual(actions.enter.applyQueryFields, { prefix: 'relative_key' }, '「进入」靠服务端声明把目录填回查询条件');
	assert.deepEqual(actions.enter.visibleWhen, { field: 'is_prefix', values: ['1'] });
	assert.deepEqual(actions.download.visibleWhen, { field: 'is_prefix', values: ['0'] });

	// 进入一层：第一行是「..」，它指回上一级。
	const level1 = await browse('shortcuts/');
	assert.deepEqual(level1.dataSource.map((row) => row.name), ['..', 'mac-studio-01/', 'mac-pro/']);
	assert.equal(level1.dataSource[0].relative_key, '', '根目录下的「..」回到根');
	const level3 = await browse('shortcuts/mac-studio-01/20260906/');
	assert.deepEqual(level3.dataSource.map((row) => row.name), ['..', '1-a.shortcut', '2-b.shortcut']);
	assert.equal(level3.dataSource[0].relative_key, 'shortcuts/mac-studio-01/', '「..」退一级，不是退到根');
	// 文件行带得出大小与时间；目录行没有，列上写明是「—」。
	assert.equal(level3.dataSource[1].size, 123);
	assert.equal(level3.columns.find((column) => column.dataIndex === 'lastModified').emptyText, '—');

	// 下载地址：key 按段编码，斜杠保留，空格与中文都要能签出来。
	const download = await (await app.request(`http://localhost${path}?binding_id=93&key=${encodeURIComponent('中文 文件.txt')}`, { method: 'PUT', headers: h })).json();
	assert.ok(download.downloadUrl, '下载地址应当生成');
	assert.match(download.downloadUrl, /%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6\.txt/, '中文与空格要编码进路径');
	assert.match(download.downloadUrl, /X-Amz-Signature=[0-9a-f]{64}/, '预签名地址要带签名');
	// 越出绑定前缀的 key 一律拒绝，路径穿越同理。
	for (const bad of ['../etc/passwd', 'shortcuts/../../secret']) {
		const refused = await app.request(`http://localhost${path}?binding_id=93&key=${encodeURIComponent(bad)}`, { method: 'PUT', headers: h });
		assert.equal(refused.status, 400, `${bad} 必须被拒绝`);
	}
	console.log('object browser test passed');
} finally {
	server.close();
	await rm(temporaryDirectory, { recursive: true, force: true });
}
