import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

/**
 * 推送的两块纯逻辑：出站目标校验（SSRF）与 Ed25519 签名。
 *
 * 不连库、不起服务：这两块的正确性只取决于输入，而它们恰恰是最不该出错的两块——
 * 前者拦的是「让服务器替人访问内网」，后者是接收方判断这条推送是不是真的来自本站的唯一依据。
 */
const directory = await mkdtemp(join(tmpdir(), 'quick-react-sms-push-'));
try {
	const result = await build({
		stdin: { contents: "export * from './server/modules/sms/push-target.mts'; export * from './server/modules/sms/platform-key.mts';", resolveDir: resolve(import.meta.dirname, '..'), sourcefile: 'sms-push-entry.mts' },
		bundle: true, format: 'esm', platform: 'node', write: false,
		external: ['node:dns/promises'],
	});
	const file = join(directory, 'push.mjs');
	await writeFile(file, result.outputFiles[0].contents);
	const { isBlockedAddress, pushTargetError, resolvedTargetError, generatePlatformKey, platformKeyId, signWithPlatformKey } = await import(pathToFileURL(file));

	// ---- SSRF：这些地址一个都不能放过（§4.9.1） ----
	for (const address of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1']) {
		assert.equal(isBlockedAddress(address), true, `${address} 必须被拦下`);
	}
	// 云元数据地址是这类攻击的头号目标：拿到的往往是一整套实例凭证。
	assert.equal(isBlockedAddress('169.254.169.254'), true);
	// 这些是正常的公网地址，不能误伤——172.32 已经出了 172.16/12 的范围。
	for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1', '2001:4860:4860::8888']) {
		assert.equal(isBlockedAddress(address), false, `${address} 不该被拦`);
	}

	assert.match(pushTargetError('http://example.com/hook'), /https/, '必须是 https：请求里带着短信正文');
	assert.match(pushTargetError('https://127.0.0.1/hook'), /内网|回环/);
	assert.match(pushTargetError('https://localhost/hook'), /本机/);
	assert.match(pushTargetError('https://[::1]/hook'), /内网|回环/);
	assert.match(pushTargetError('不是地址'), /格式/);
	assert.equal(pushTargetError('https://example.com/sms-hook'), '', '正常的 https 地址要放行');
	// 解析后仍要判一次：写成域名的内网地址在保存那一步看不出来。
	assert.match(await resolvedTargetError('https://127.0.0.1/hook'), /内网|回环/);

	// ---- 签名：接收方据此判断这条推送是不是真的来自本站 ----
	const generated = await generatePlatformKey();
	assert.match(generated.publicKey, /^[A-Za-z0-9_-]{43}$/, '公钥是 32 字节的 Base64URL');
	assert.equal(generated.kid, await platformKeyId(generated.publicKey), 'kid 由公钥算出，不另外指定');
	assert.match(generated.kid, /^[0-9a-f]{16}$/);
	const payload = `1788432000.${JSON.stringify({ content: '验证码 8848' })}`;
	const signature = await signWithPlatformKey(generated.privateKey, payload);
	assert.match(signature, /^[A-Za-z0-9_-]{86}$/, '签名是 64 字节的 Base64URL');
	// 用公开出去的那把公钥验一遍——接收方走的就是这条路。
	const verify = async (publicKeyBase64Url, signatureValue, signedPayload) => {
		const raw = Uint8Array.from(atob(publicKeyBase64Url.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
		const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
		const bytes = Uint8Array.from(atob(signatureValue.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
		return crypto.subtle.verify({ name: 'Ed25519' }, key, bytes, new TextEncoder().encode(signedPayload));
	};
	assert.equal(await verify(generated.publicKey, signature, payload), true, '本站签的名，接收方要验得过');
	assert.equal(await verify(generated.publicKey, signature, `1788432001.${JSON.stringify({ content: '验证码 8848' })}`), false, '改时间戳要验不过——否则重放窗口形同虚设');
	assert.equal(await verify(generated.publicKey, signature, `1788432000.${JSON.stringify({ content: '验证码 0000' })}`), false, '改正文要验不过');
	const other = await generatePlatformKey();
	assert.equal(await verify(other.publicKey, signature, payload), false, '换一把公钥要验不过');

	console.log('sms push unit checks passed');
} finally {
	await rm(directory, { recursive: true, force: true });
}

/**
 * 端到端：短信进来 → 登记投递 → 发出去 → 接收方按公钥验签。
 *
 * 接收方跑在 127.0.0.1 上，因此要显式打开本地例外（§4.9.1「本地开发可显式配置例外」）。
 * **先验证不开例外时它确实被拦下**——那个开关等于关掉 SSRF 防护，得先确认防护本身在工作，
 * 再打开它去验后面的链路。
 */
const receiverRequests = [];
const receiver = createServer((request, response) => {
	let body = '';
	request.on('data', (chunk) => { body += chunk; });
	request.on('end', () => {
		receiverRequests.push({ url: request.url, headers: request.headers, body });
		response.writeHead(200);
		response.end('ok');
	});
});
await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const receiverPort = receiver.address().port;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-sms-push-e2e-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';
try {
	const { app, runMaintenanceAction } = await import(`../dist/server.mjs?sms-push=${Date.now()}`);
	const seed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const now = Date.now();
	seed.prepare("INSERT INTO global_site_hosts (key, hostname, site_key, status, created_at) VALUES (lower(hex(randomblob(16))), 'sms.test', 'sms', 'enabled', ?)").run(now);
	seed.close();
	await runMaintenanceAction('restore-admin', { user_name: 'pushadmin', password: 'push-password-1' });
	const headers = {
		'content-type': 'application/json',
		'x-device-key': '00000000000040008000000000000001',
		'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: 'a', audio_cyrb53: 'b' }),
	};
	const login = await app.request('http://sms.test/api/sign.php', { method: 'POST', headers, body: JSON.stringify({ user_name: 'pushadmin', password: 'push-password-1' }) });
	const h = { ...headers, cookie: login.headers.get('set-cookie')?.split(';')[0] };
	const approveAll = async () => {
		const pending = await (await app.request('http://sms.test/api/panel/admin/base/audit/records.php?include=data&review_status=pending', { headers: h })).json();
		const ids = (pending.table?.dataSource ?? []).map((row) => String(row.id));
		if (ids.length) await app.request('http://sms.test/api/panel/admin/base/audit/records.php?action=approve', { method: 'POST', headers: h, body: JSON.stringify(ids) });
	};

	// 没有签名密钥时，公钥端点要说清楚该去哪生成，而不是回一个空数组让接收方自己猜。
	assert.match(String((await (await app.request('http://sms.test/api/push-key.php')).json()).feedback?.message), /还没有生成推送签名密钥/);
	/**
	 * ---- 轮换顺序：先公布，再启用签名 ----
	 *
	 * 接收方按公钥比对 `/api/push-key` 的名单来判定来源，而他们会缓存那份名单。先签后公布的
	 * 话，那一刻发出去的推送在接收方眼里就是一把没见过的公钥签的，被当成伪造丢掉——而本站
	 * 这边只看到一堆投递失败，看不出原因。所以生成只公布、不签名，启用是单独一步。
	 *
	 * 这个顺序**由状态结构保证**，不靠人记：签名只认 `active`，新密钥落地是 `publishing`。
	 */
	// 这一步会进审批队列（后台的写入都要过审批），批准之后密钥才落地。
	await app.request('http://sms.test/api/panel/admin/sms/platform-keys.php?action=generate', { method: 'POST', headers: h, body: JSON.stringify({ reason: '首次生成' }) });
	await approveAll();

	const keyRows = () => {
		const db = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
		const rows = db.prepare('SELECT id, kid, status FROM sms_platform_keys ORDER BY id').all();
		db.close();
		return rows;
	};
	assert.deepEqual(keyRows().map((row) => row.status), ['publishing'], '刚生成的密钥是「公布中」，不是「签名中」');
	// 已经公布了：接收方现在就能把它放进缓存——这正是先公布的意义。
	const beforeActivate = await (await app.request('http://sms.test/api/push-key.php')).json();
	assert.equal(beforeActivate.keys.length, 1, '公布中的密钥要立刻出现在公钥端点里');
	assert.equal(beforeActivate.keys[0].status, 'publishing');

	const firstKeyId = keyRows()[0].id;
	await app.request(`http://sms.test/api/panel/admin/sms/platform-keys.php/${firstKeyId}?action=activate`, { method: 'POST', headers: h, body: JSON.stringify({ reason: '启用签名' }) });
	await approveAll();
	assert.deepEqual(keyRows().map((row) => row.status), ['active'], '启用之后才是签名用的那把');

	const database = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const ownerId = database.prepare("SELECT id FROM base_users WHERE name = 'pushadmin'").get().id;
	database.prepare("INSERT INTO sms_phones (key, id, number, title, status, owner_uid, bound_at, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 1, '+8613800138000', '主力机', 'enabled', ?, ?, ?, ?)").run(ownerId, now, now, now);
	database.prepare("INSERT INTO sms_shortcut_tokens (key, id, token_sha256, status, phone_id, owner_uid, idempotency_token, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 1, ?, 'bound', 1, ?, 'idem', ?, ?)").run(createHash('sha256').update('raw-token').digest('hex'), ownerId, now, now);
	// 池子里再留一个：后面另一个人也要登记同一个号码，绑定要从池子里领一把。
	database.prepare("INSERT INTO sms_shortcut_tokens (key, id, token_sha256, status, idempotency_token, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 2, ?, 'available', 'idem-spare', ?, ?)").run(createHash('sha256').update('spare-token').digest('hex'), now, now);
	database.close();

	// ---- 防护先于例外：这两条必须被拦 ----
	const endpointsPath = 'http://sms.test/api/panel/user/sms/push-endpoints.php';
	const post = async (body) => {
		const response = await app.request(endpointsPath, { method: 'POST', headers: h, body: JSON.stringify(body) });
		return { status: response.status, message: (await response.json()).feedback?.message ?? '' };
	};
	assert.match((await post({ url: `https://127.0.0.1:${receiverPort}/hook`, status: 'enabled' })).message, /内网|回环/, '内网地址要拦下——否则推送成了从服务器发起的任意内网请求');
	assert.match((await post({ url: 'http://example.com/hook', status: 'enabled' })).message, /https/, '必须 https：请求里带着短信正文');

	process.env.SMS_PUSH_ALLOW_LOCAL_TARGETS = '1';
	assert.equal((await post({ url: `http://127.0.0.1:${receiverPort}/hook`, status: 'enabled' })).status, 201, '开了本地例外才收得下 127.0.0.1');

	/**
	 * ---- 自检：手机的主人手动运行一次快捷指令 ----
	 *
	 * 没有短信触发，三个字段都是空的。以前回的是「短信正文不能为空」——每一条坏路径都会说
	 * 人话，唯独一切正常的这一条说的像报错。
	 */
	const receive = (body) => app.request('http://sms.test/api/shortcut/message-receive.php', { method: 'POST', headers: { authorization: 'Bearer raw-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const checked = await receive({});
	assert.equal(checked.status, 200, '手动运行快捷指令要回成功');
	const checkedMessage = String((await checked.json()).feedback?.message);
	assert.match(checkedMessage, /测试成功/);
	assert.match(checkedMessage, /\+8613800138000（主力机）/, '要告诉手机的主人这份快捷指令绑的是哪个号码——完整号码，打码就分不清是哪一部');
	assert.doesNotMatch(checkedMessage, /推送|项目/, '读回执的是手机的主人，推送地址、项目对他是黑话');
	// 快捷指令不会自己在收到短信时运行。自检判断不出自动化建没建，所以必须每次提醒——
	// 说成「以后会自动转发」的话，没建自动化的人会以为设好了，实际一条都不转。
	assert.match(checkedMessage, /自动化/, '要提醒建一条「收到信息时运行」的自动化');
	assert.doesNotMatch(checkedMessage, /以后这部手机收到的短信会自动转发/);
	assert.ok(!checkedMessage.includes('\n'), '回执写成一行：快捷指令把响应当字典显示，换行会原样露出');
	// 正文空但带着发送人：是真短信没取到正文（例如系统更新后读不到了），不能当自检咽下去——
	// 否则每条真短信都静默丢掉，后台还显示「最近自检：刚刚」。
	const broken = await receive({ content: '', sender: '10086', message_id: 'm-empty' });
	assert.equal(broken.status, 400);
	assert.match(String((await broken.json()).feedback?.message), /没有取到正文/);
	const afterCheck = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.ok(Number(afterCheck.prepare('SELECT last_check_at FROM sms_phones WHERE id = 1').get().last_check_at) > 0, '自检要记下时间');
	assert.equal(afterCheck.prepare('SELECT last_used_at FROM sms_shortcut_tokens WHERE id = 1').get().last_used_at, null, '自检不刷新「最近收到短信」：两件事分开记');
	assert.equal(afterCheck.prepare('SELECT COUNT(*) AS n FROM sms_messages').get().n, 0, '自检不进短信表');
	assert.equal(afterCheck.prepare('SELECT COUNT(*) AS n FROM sms_push_deliveries').get().n, 0, '自检也不推送：接入方的服务器不该收到一条空短信');
	afterCheck.close();
	/**
	 * ---- 接收日志：到底收到了什么 ----
	 *
	 * 快捷指令跑在别人手机上，出了问题原来一点痕迹不留。三件事要守住：失败的记完整请求体，
	 * 成功的不在日志里再存一份正文，原始令牌任何情况下都不出现。
	 */
	const receiveLogs = [];
	const originalLog = console.log;
	console.log = (...args) => {
		const line = args.join(' ');
		if (line.startsWith('[sms-receive] ')) receiveLogs.push({ line, entry: JSON.parse(line.slice('[sms-receive] '.length)) });
		else originalLog(...args);
	};
	await receive({});
	await receive({ content: '', sender: '10086', message_id: 'm-empty-2' });
	await app.request('http://sms.test/api/shortcut/message-receive.php', { method: 'POST', headers: { authorization: 'Bearer not-a-real-token', 'content-type': 'application/json' }, body: JSON.stringify({ content: '随便谁写的东西' }) });
	console.log = originalLog;
	const [okLog, failedLog, unknownLog] = receiveLogs.map((item) => item.entry);
	assert.equal(receiveLogs.length, 3, '每一次提交都要留一行');
	assert.equal(okLog.status, 200);
	assert.equal(okLog.token.id, '1', '记令牌在库里的编号');
	assert.equal(okLog.phone_id, '1');
	assert.equal(okLog.body, undefined, '成功的不记请求体');
	assert.equal(failedLog.status, 400);
	assert.equal(failedLog.body.sender, '10086', '失败的记完整请求体——那正是要查的');
	assert.match(failedLog.message, /没有取到正文/);
	assert.equal(unknownLog.status, 401);
	assert.equal(unknownLog.token, null);
	assert.ok(!unknownLog.line?.includes('随便谁写的东西') && !receiveLogs[2].line.includes('随便谁写的东西'), '认不出的令牌只记字段名与长度');
	assert.deepEqual(unknownLog.fields, ['content']);
	for (const { line } of receiveLogs) {
		assert.ok(!line.includes('raw-token') && !line.includes('not-a-real-token'), '原始令牌任何情况下都不进日志');
		assert.ok(!line.includes(createHash('sha256').update('raw-token').digest('hex')), '令牌摘要同样不进日志');
	}

	const myPhones = await (await app.request('http://sms.test/api/panel/user/sms/phones.php?include=data', { headers: h })).json();
	const mainPhone = myPhones.table.dataSource.find((row) => String(row.id) === '1');
	assert.ok(Number(mainPhone.last_check_at) > 0, '后台「我的手机」要看得到最近自检');
	assert.equal(mainPhone.last_message_at, null, '还没来过真短信');
	assert.equal(mainPhone.push_hint, 'configured', '配了一条不限项目的地址，这部手机的短信会转发出去');

	// ---- 短信进来：登记投递任务，但不在接收接口里发出去 ----
	const received = await app.request('http://sms.test/api/shortcut/message-receive.php', { method: 'POST', headers: { authorization: 'Bearer raw-token', 'content-type': 'application/json' }, body: JSON.stringify({ message_id: 'm-1', content: '【测试】验证码 8848', sender: '10086' }) });
	assert.equal(received.status, 200);
	assert.equal(receiverRequests.length, 0, '接收接口不等外部请求：对面慢一秒，手机上的 Shortcut 就多等一秒、超时重发');
	const queued = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(queued.prepare("SELECT COUNT(*) AS n FROM sms_push_deliveries WHERE status = 'pending'").get().n, 1);
	queued.close();

	// ---- 跑一轮投递 ----
	assert.deepEqual(await runMaintenanceAction('dispatch-sms-push', {}), { sent: 1, failed: 0 });
	assert.equal(receiverRequests.length, 1, '接收方要收到一条');
	const delivered = receiverRequests[0];
	// 请求体是信封：三个字段，payload 是一段 JSON 字符串。与绑定方向完全对称。
	const envelope = JSON.parse(delivered.body);
	assert.deepEqual(Object.keys(envelope).sort(), ['payload', 'publicKey', 'signature'], '信封只有这三个字段');
	assert.equal(typeof envelope.payload, 'string', 'payload 必须是字符串——接收方直接拿它验签，不必留住原始请求体');
	// 不再发 kid，也不再有任何 X-Sms-* 请求头：来源靠信封里的 publicKey 核对。
	assert.equal(delivered.headers['x-sms-key-id'], undefined);
	assert.equal(delivered.headers['x-sms-signature'], undefined);
	assert.equal(delivered.headers['x-sms-timestamp'], undefined);

	const payload = JSON.parse(envelope.payload);
	assert.equal(payload.content, '【测试】验证码 8848');
	assert.ok(Number.isFinite(payload.ts), 'ts 在 payload 里，因此被签名覆盖');
	assert.ok(payload.delivery_id, 'delivery_id 也在 payload 里，接收方按它去重');
	// 号码不打码：接入方要按号码认出自己的客户，只给后四位的话，没传 client_ref 时他没有
	// 别的办法把这条短信对回自己的记录。
	assert.equal(payload.phone, '+8613800138000');
	assert.equal(payload.client_ref, null, '这部手机绑定时没传 client_ref');
	assert.ok(!delivered.body.includes('raw-token'), '推送里不得出现原始令牌');

	/**
	 * ---- 接收方该怎么验：先核对公钥来源，再验签 ----
	 *
	 * **第一步不能省。** 信封里的 publicKey 是发送方自己填的，不比对 /api/push-key 公布的
	 * 那几把，任何人都能拿自己的私钥签一条假推送、把公钥一并填进去，验签照样通过。
	 */
	const published = await (await app.request('http://sms.test/api/push-key.php')).json();
	const matched = published.keys.find((item) => item.public_key === envelope.publicKey);
	assert.ok(matched, '信封里的 publicKey 必须能在公钥端点里找到——找不到就该当成伪造的丢掉');
	const verifyDelivered = async (publicKeyBase64Url, signedInput) => {
		const raw = Uint8Array.from(atob(publicKeyBase64Url.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
		const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
		const value = String(envelope.signature).replace('ed25519=', '');
		const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
		return crypto.subtle.verify({ name: 'Ed25519' }, key, bytes, new TextEncoder().encode(signedInput));
	};
	assert.equal(await verifyDelivered(matched.public_key, envelope.payload), true, '接收方要验得过');
	assert.equal(await verifyDelivered(matched.public_key, envelope.payload.replace('8848', '0000')), false, '改正文要验不过');
	assert.equal(await verifyDelivered(matched.public_key, envelope.payload.replace(/"ts":\d+/, '"ts":1')), false, '改时间戳要验不过——它在 payload 里，被签名盖住了');

	// ---- 成功之后不再重投，地址上记下最近成功 ----
	assert.deepEqual(await runMaintenanceAction('dispatch-sms-push', {}), { sent: 0, failed: 0 }, '成功的任务不该再发一次');
	assert.equal(receiverRequests.length, 1);
	const finished = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(finished.prepare('SELECT status FROM sms_push_deliveries').get().status, 'succeeded');
	assert.ok(Number(finished.prepare('SELECT last_success_at FROM sms_push_endpoints').get().last_success_at) > 0);
	finished.close();

	/**
	 * ---- 「我的短信」列表要看得到推送成没成功 ----
	 *
	 * 短信记录与投递记录原来是两张互不相通的表：这一页只显示短信内容，「推送地址」页只有
	 * 端点级别的「最近成功/最近错误」——看不出**这一条具体的短信**推没推、成没成功。
	 */
	const myMessages = await (await app.request('http://sms.test/api/panel/user/sms/messages.php?include=data', { headers: h })).json();
	const succeededRow = myMessages.table.dataSource.find((row) => row.content === '【测试】验证码 8848');
	assert.equal(succeededRow.push_status, 'succeeded', '已经推送成功的短信要显示成功');
	assert.equal(succeededRow.push_error, null);

	// 停用推送地址之后再来一条短信：这条完全匹配不到任何投递目标，要显示「未匹配推送地址」，
	// 而不是显示成「推送失败」——两者原因不同，处理方式也不同。
	await app.request('http://sms.test/api/panel/user/sms/push-endpoints.php/1', { method: 'PUT', headers: h, body: JSON.stringify({ status: 'disabled' }) });
	await app.request('http://sms.test/api/shortcut/message-receive.php', { method: 'POST', headers: { authorization: 'Bearer raw-token', 'content-type': 'application/json' }, body: JSON.stringify({ message_id: 'm-unmatched', content: '没有地址接得住', sender: '10086' }) });
	const afterUnmatched = await (await app.request('http://sms.test/api/panel/user/sms/messages.php?include=data', { headers: h })).json();
	const unmatchedRow = afterUnmatched.table.dataSource.find((row) => row.content === '没有地址接得住');
	assert.equal(unmatchedRow.push_status, 'unmatched', '停用推送地址之后到的短信，匹配不到任何投递目标');
	await app.request('http://sms.test/api/panel/user/sms/push-endpoints.php/1', { method: 'PUT', headers: h, body: JSON.stringify({ status: 'enabled' }) });

	// 推送失败也要在列表上看得出来，并带上最近一次的错误摘要。指向一个保证没人监听的端口
	// 制造连接失败，而不是关掉共享的 receiver——后面的隔离测试还要用它。
	const deadServer = createServer();
	await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
	const deadPort = deadServer.address().port;
	await new Promise((resolve) => deadServer.close(resolve));
	await app.request('http://sms.test/api/panel/user/sms/push-endpoints.php/1', { method: 'PUT', headers: h, body: JSON.stringify({ url: `http://127.0.0.1:${deadPort}/hook` }) });
	await app.request('http://sms.test/api/shortcut/message-receive.php', { method: 'POST', headers: { authorization: 'Bearer raw-token', 'content-type': 'application/json' }, body: JSON.stringify({ message_id: 'm-failed', content: '这条推不出去', sender: '10086' }) });
	await runMaintenanceAction('dispatch-sms-push', {});
	const afterFailed = await (await app.request('http://sms.test/api/panel/user/sms/messages.php?include=data', { headers: h })).json();
	const failedRow = afterFailed.table.dataSource.find((row) => row.content === '这条推不出去');
	assert.equal(failedRow.push_status, 'pending', '还在重试计划内，不是终态失败');
	assert.ok(failedRow.push_error, '要带上最近一次失败的原因');
	// 恢复成能用的地址，不影响后面的测试。
	await app.request('http://sms.test/api/panel/user/sms/push-endpoints.php/1', { method: 'PUT', headers: h, body: JSON.stringify({ url: `http://127.0.0.1:${receiverPort}/hook` }) });

	/**
	 * **跨账号隔离**：另一个人绑不走同一个号码，也收不到别人的短信。
	 *
	 * 这是这套东西最要紧的一条边界——短信里是验证码。三层各自独立生效：号码在租户内唯一，
	 * 别人根本绑不上；就算绑上了（跨租户），短信是从某一个令牌进来的、归属那个令牌的主人；
	 * 推送匹配按 owner_uid，别人的地址匹配不到。
	 */
	await app.request('http://sms.test/api/panel/admin/base/users.php', { method: 'POST', headers: h, body: JSON.stringify({ user_name: 'pushother', password: 'push-password-1', roles: [], status: 'enabled' }) });
	await approveAll();
	const otherLogin = await app.request('http://sms.test/api/sign.php', { method: 'POST', headers, body: JSON.stringify({ user_name: 'pushother', password: 'push-password-1' }) });
	const other = { ...headers, cookie: otherLogin.headers.get('set-cookie')?.split(';')[0] };

	/**
	 * **别人可以登记同一个号码**——手机往往是本站用户的客户的，两家服务商服务同一位客户
	 * 是常事，各自给那部手机装自己的快捷指令。
	 *
	 * 登记之后他确实拿到了自己的一行手机、自己的令牌、自己那份 `.shortcut` 文件。但那份
	 * 文件**有没有被装进那部手机是物理动作**——系统管不了，也不需要管：装得上说明手机的
	 * 主人同意了，那本来就是授权；装不上，他手里就只是一部永远收不到短信的记录。
	 *
	 * 所以这里验的不是「他拿不到令牌」，而是**一条短信都不会记到他名下**：短信从哪个令牌
	 * 进来就归属谁，而客户手机上装的是先来那家的快捷指令。
	 */
	const grabbed = await app.request('http://sms.test/api/panel/user/sms/phones.php?action=bind', { method: 'POST', headers: other, body: JSON.stringify({ number: '13800138000', title: '我也想要' }) });
	assert.equal(grabbed.status, 200, '别人可以登记同一个号码——那是他自己的一行，不是抢走');
	// 他还没配推送地址：后台要提示短信只躺在平台上——手机上的回执不说这件事，这里是唯一
	// 能在不发真短信的前提下提前发现的地方。
	const otherPhones = await (await app.request('http://sms.test/api/panel/user/sms/phones.php?include=data', { headers: other })).json();
	assert.equal(otherPhones.table.dataSource[0].push_hint, 'none', '没配推送地址要提示');

	// 另一个人配一条不限定手机的推送地址，短信仍然不该推给他。
	await app.request('http://sms.test/api/panel/user/sms/push-endpoints.php', { method: 'POST', headers: other, body: JSON.stringify({ url: `http://127.0.0.1:${receiverPort}/other`, status: 'enabled' }) });
	await app.request('http://sms.test/api/shortcut/message-receive.php', { method: 'POST', headers: { authorization: 'Bearer raw-token', 'content-type': 'application/json' }, body: JSON.stringify({ message_id: 'm-2', content: '第二条', sender: '10086' }) });
	await runMaintenanceAction('dispatch-sms-push', {});
	assert.equal(receiverRequests.filter((item) => item.url === '/other').length, 0, '别人的地址不该收到');
	const isolated = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	const otherId = isolated.prepare("SELECT id FROM base_users WHERE name = 'pushother'").get().id;
	assert.equal(isolated.prepare('SELECT COUNT(*) AS n FROM sms_push_deliveries d JOIN sms_push_endpoints e ON e.id = d.push_endpoint_id WHERE e.owner_uid = ?').get(otherId).n, 0, '别人的地址不该收到任何投递');
	// 他名下确实多了一行手机，但那一行没有令牌、收不到任何短信。
	assert.equal(isolated.prepare('SELECT COUNT(*) AS n FROM sms_phones WHERE owner_uid = ?').get(otherId).n, 1);
	// 他领到了自己的令牌（绑定本来就会发一份快捷指令给他），但那份没装进客户的手机。
	assert.equal(isolated.prepare('SELECT COUNT(*) AS n FROM sms_shortcut_tokens t JOIN sms_phones p ON p.id = t.phone_id WHERE p.owner_uid = ?').get(otherId).n, 1);
	assert.equal(isolated.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE owner_uid = ?').get(otherId).n, 0, '一条短信都不该记到他名下——短信从哪个令牌进来就归属谁');
	isolated.close();

	/**
	 * **按项目配对**：手机登记在哪个项目下，就只推给那个项目的地址。
	 *
	 * 手机往往是客户的。客户把手机交给项目 X 用，不等于同意项目 Y 也读他的验证码——同一个
	 * 人名下的另一个项目配一条限定这部手机的地址就能收到的话，那是越权。`0` 是一个有效的
	 * 分组（用户自己的手机），配对到同样没挂项目的那些地址。
	 */
	const clientCreated = await app.request('http://sms.test/api/panel/user/sms/integration-clients.php', { method: 'POST', headers: h, body: JSON.stringify({ name: 'sideproject', title: '另一个项目', binding_scope: ['phone:bind'], status: 'enabled' }) });
	assert.equal(clientCreated.status, 201);
	const sideClient = (await (await app.request('http://sms.test/api/panel/user/sms/integration-clients.php?include=data', { headers: h })).json()).table.dataSource.find((row) => row.name === 'sideproject');
	// 另一个项目也盯着同一部手机
	await app.request('http://sms.test/api/panel/user/sms/push-endpoints.php', { method: 'POST', headers: h, body: JSON.stringify({ url: `http://127.0.0.1:${receiverPort}/side`, status: 'enabled', integration_client_id: String(sideClient.id), phone_id: '1' }) });
	await app.request('http://sms.test/api/shortcut/message-receive.php', { method: 'POST', headers: { authorization: 'Bearer raw-token', 'content-type': 'application/json' }, body: JSON.stringify({ message_id: 'm-3', content: '第三条', sender: '10086' }) });
	await runMaintenanceAction('dispatch-sms-push', {});
	assert.equal(receiverRequests.filter((item) => item.url === '/side').length, 0, '手机没登记在那个项目下，它就收不到——客户把手机交给一个项目用，不等于同意另一个也读');

	/**
	 * ---- 一条短信匹配好几个推送地址：显示最差的那个状态 ----
	 *
	 * 直接在库里造两条投递记录（一条成功、一条还在重试），不经过真实的匹配流程——那条
	 * 流程本身已经在别处测过，这里只测聚合函数本身：`reduce` 从空数组开始会抛异常，
	 * 排名权重给错了会悄悄选到错的那一行，两种坏法都不会在页面上表现成明显的报错。
	 */
	const mixedSetup = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const mixedOwnerId = mixedSetup.prepare("SELECT id FROM base_users WHERE name = 'pushadmin'").get().id;
	mixedSetup.prepare("INSERT INTO sms_messages (key, id, phone_id, content, sender, received_at, owner_uid, payload_hash, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 999, 1, '两个地址', '10086', ?, ?, 'mixed-hash', ?, ?)").run(Date.now(), mixedOwnerId, Date.now(), Date.now());
	mixedSetup.prepare("INSERT INTO sms_push_endpoints (key, id, url, status, owner_uid, integration_client_id, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 998, 'https://example.invalid/a', 'enabled', ?, '0', ?, ?)").run(mixedOwnerId, Date.now(), Date.now());
	mixedSetup.prepare("INSERT INTO sms_push_endpoints (key, id, url, status, owner_uid, integration_client_id, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 997, 'https://example.invalid/b', 'enabled', ?, '0', ?, ?)").run(mixedOwnerId, Date.now(), Date.now());
	mixedSetup.prepare("INSERT INTO sms_push_deliveries (key, message_id, push_endpoint_id, delivery_id, status, owner_uid, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 999, 998, 'mixed-a', 'succeeded', ?, ?, ?)").run(mixedOwnerId, Date.now(), Date.now());
	mixedSetup.prepare("INSERT INTO sms_push_deliveries (key, message_id, push_endpoint_id, delivery_id, status, last_error, owner_uid, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 999, 997, 'mixed-b', 'failed', '目标返回 500', ?, ?, ?)").run(mixedOwnerId, Date.now(), Date.now());
	mixedSetup.close();
	const mixedList = await (await app.request('http://sms.test/api/panel/user/sms/messages.php?include=data', { headers: h })).json();
	const mixedRow = mixedList.table.dataSource.find((row) => row.content === '两个地址');
	assert.equal(mixedRow.push_status, 'failed', '一成一败要显示失败那个——只要有一个地址没成功，就不该让人以为已经推送');
	assert.equal(mixedRow.push_error, '目标返回 500');

	console.log('sms push test passed');
} finally {
	receiver.close();
	delete process.env.SMS_PUSH_ALLOW_LOCAL_TARGETS;
	await rm(temporaryDirectory, { recursive: true, force: true });
}
