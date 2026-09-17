import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';

/**
 * 票据路径端到端（绑定文档 §6.2、§7.2）：接入方用自己的 Ed25519 私钥签一次绑定请求，
 * 代表自己的账号绑一个手机号。请求体是一个信封：`{publicKey, signature, payload}`，
 * 其中 `payload` 是一段 JSON 字符串，签的就是这段字符串本身的字节。
 *
 * **没有自定义请求头，Content-Type 是 text/plain**——这样浏览器按 CORS 简单请求发出去，
 * 不触发 OPTIONS 预检。`ts` 与 `nonce` 也在 payload 里，因此一并被签住。
 *
 * **身份就是公钥**（同 GitHub 的 SSH）：请求头带着公钥，服务端反查出接入方与归属账号。
 * 因此这里最要紧的一条是「换成谁的公钥就得拿谁的私钥来签」——下面用两个账号各自的钥匙
 * 各绑一次，验手机落在各自名下。
 *
 * 这条路径上没有本站会话，签名本身就是凭证，每一条失败规则都要守得住：验签、时间窗、
 * 公钥退役、权限范围、nonce 一次性。少守一条，一个过期请求或一把退役公钥就能往别人
 * 账号里插手机。
 */
const base64url = (buffer) => Buffer.from(buffer).toString('base64url');

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'quick-react-sms-ticket-'));
process.env.DEFAULT_DATABASE_FILE = join(temporaryDirectory, 'default.sqlite');
process.env.SKIP_SERVER_LISTEN = '1';
try {
	const { app, runMaintenanceAction } = await import(`../dist/server.mjs?sms-ticket=${Date.now()}`);
	const now = Date.now();
	const seed = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	seed.prepare("INSERT INTO global_site_hosts (key, hostname, site_key, status, created_at) VALUES (lower(hex(randomblob(16))), 'sms.test', 'sms', 'enabled', ?)").run(now);
	seed.close();
	await runMaintenanceAction('restore-admin', { user_name: 'ticketadmin', password: 'ticket-password-1' });

	const headers = {
		'content-type': 'application/json',
		'x-device-key': '00000000000040008000000000000002',
		'x-device-fingerprint': JSON.stringify({ canvas_cyrb53: 'a', audio_cyrb53: 'b' }),
	};
	const signIn = async (userName) => {
		const login = await app.request('http://sms.test/api/sign.php', { method: 'POST', headers, body: JSON.stringify({ user_name: userName, password: 'ticket-password-1' }) });
		assert.equal(login.status, 200, `${userName} 要能登录`);
		return { ...headers, cookie: login.headers.get('set-cookie')?.split(';')[0] };
	};
	const h = await signIn('ticketadmin');
	const approveAll = async () => {
		const pending = await (await app.request('http://sms.test/api/panel/admin/base/audit/records.php?include=data&review_status=pending', { headers: h })).json();
		const ids = (pending.table?.dataSource ?? []).map((row) => String(row.id));
		if (ids.length) await app.request('http://sms.test/api/panel/admin/base/audit/records.php?action=approve', { method: 'POST', headers: h, body: JSON.stringify(ids) });
	};

	// 第二个账号：用来验「不是自己名下的账号，签了票据也绑不了」。
	await app.request('http://sms.test/api/panel/admin/base/users.php', { method: 'POST', headers: h, body: JSON.stringify({ user_name: 'ticketother', password: 'ticket-password-1', roles: [], status: 'enabled' }) });
	await approveAll();

	// ---- 接入方与它的公钥 ----
	const createClient = async (name, title, scope) => {
		const created = await app.request('http://sms.test/api/panel/user/sms/integration-clients.php', { method: 'POST', headers: h, body: JSON.stringify({ name, title, binding_scope: scope, status: 'enabled' }) });
		assert.equal(created.status, 201, `${name} 要建得起来`);
		const list = await (await app.request('http://sms.test/api/panel/user/sms/integration-clients.php?include=data', { headers: h })).json();
		return list.table.dataSource.find((row) => row.name === name);
	};
	const client = await createClient('ticketclient', '票据接入方', ['phone:bind']);
	// 没有 phone:bind 的那家：能力范围不是摆设，它得真的拦住。登记接口不收空能力，
	// 所以直接把这一行的能力清掉——模拟的是「将来有了别的能力，而这家没勾绑定手机」。
	const readOnlyClient = await createClient('readonlyclient', '只读接入方', ['phone:bind']);
	const scopeDatabase = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	scopeDatabase.prepare("UPDATE sms_integration_clients SET binding_scope = '' WHERE name = 'readonlyclient'").run();
	scopeDatabase.close();

	const keypair = () => {
		const pair = generateKeyPairSync('ed25519');
		const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
		return { privateKey: pair.privateKey, publicKey: base64url(raw) };
	};
	const registerKey = async (clientId, kid, publicKey, session = h) => {
		const created = await app.request('http://sms.test/api/panel/user/sms/client-keys.php', { method: 'POST', headers: session, body: JSON.stringify({ integration_client_id: String(clientId), kid, public_key: publicKey, status: 'active' }) });
		const message = (await created.json().catch(() => ({}))).feedback?.message ?? '';
		if (created.status !== 201) return { status: created.status, message };
		const list = await (await app.request('http://sms.test/api/panel/user/sms/client-keys.php?include=data', { headers: session })).json();
		return { status: 201, message, row: list.table.dataSource.find((row) => row.kid === kid) };
	};
	const live = keypair();
	const retired = keypair();
	const readOnly = keypair();
	assert.equal((await registerKey(client.id, 'k-live', live.publicKey)).status, 201);
	const retiredRow = (await registerKey(client.id, 'k-retired', retired.publicKey)).row;
	assert.equal((await registerKey(readOnlyClient.id, 'k-readonly', readOnly.publicKey)).status, 201);
	const retireResponse = await app.request(`http://sms.test/api/panel/user/sms/client-keys.php/${retiredRow.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ status: 'retired' }) });
	assert.equal(retireResponse.status, 200, '退役要生效——轮换的意义全在这一句');

	/**
	 * **同一把公钥全库只能登记一次。** 公钥就是身份，同一把被两家登记，绑定该算谁的就
	 * 说不清了——服务端会在两个身份里挑一个，而挑哪个取决于行序，那是最难查的一类 bug。
	 */
	const duplicate = await registerKey(readOnlyClient.id, 'k-dup', live.publicKey);
	assert.equal(duplicate.status, 409, '同一把公钥不能登记两次');
	assert.match(duplicate.message, /已经登记过/);
	// 退役过的也不能登记回来（唯一索引不带 deleted_at，查重也不看归属与软删）：
	// 一把退役过的钥匙，退役的理由多半还在。要「换回去」只能再生成一对新的。
	assert.equal((await registerKey(client.id, 'k-revive', retired.publicKey)).status, 409, '退役过的公钥不能借尸还魂');

	// ---- 令牌池：绑定要从池子里领一把，池子空了绑不了 ----
	const database = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE);
	const ownerId = database.prepare("SELECT id FROM base_users WHERE name = 'ticketadmin'").get().id;
	const otherId = database.prepare("SELECT id FROM base_users WHERE name = 'ticketother'").get().id;
	for (let index = 1; index <= 24; index += 1) {
		database.prepare("INSERT INTO sms_shortcut_tokens (key, token_sha256, status, idempotency_token, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, 'available', ?, ?, ?)")
			.run(createHash('sha256').update(`pool-${index}`).digest('hex'), `idem-${index}`, now, now);
	}
	database.close();

	// ---- 签绑定请求 ----
	let nonceCounter = 0;
	/**
	 * 身份只有一个字段：`public_key`，放请求头，不在请求体里。接入方与归属账号都由服务端
	 * 反查。默认拿 `live` 那一对签——公钥填 live 的、私钥也用 live 的，两者必须配对。
	 *
	 * `overrides` 是请求体的业务字段（phone/key/client_ref/title）；`options` 控制签名本身：
	 * `privateKey` 换一把签名用的私钥、`publicKeyHeader` 单独覆盖请求头里声明的公钥（用于
	 * "声明的公钥与实际签名的私钥对不上"这类测试）、`timestamp` 覆盖时间戳。
	 *
	 * 返回 `{ headers, rawBody }`，同一个返回值可以被 `bind()` 调用两次——正是用来测
	 * nonce 重放的那个场景，不用每次都重新生成。
	 */
	const makeTicket = (overrides = {}, options = {}) => {
		const ts = Number(options.timestamp ?? Math.floor(Date.now() / 1000));
		/**
		 * `payload` 是一段 **JSON 字符串**，签的就是这串字符的 UTF-8 字节。
		 *
		 * 这里必须用同一个字符串既签名又发送——重新序列化一遍再发的话，键序或空格差一点
		 * 就验不过，而那正是这套协议要避免的坑。
		 */
		const payload = JSON.stringify({ ts, nonce: `n-${++nonceCounter}`, phone: '+8613800138000', ...overrides });
		const signature = nodeSign(null, Buffer.from(payload, 'utf8'), options.privateKey ?? live.privateKey);
		const envelope = {
			publicKey: options.publicKeyHeader ?? live.publicKey,
			signature: `ed25519=${base64url(signature)}`,
			payload,
		};
		return { rawBody: JSON.stringify(envelope), payload };
	};
	const bind = async (ticket, extra = {}) => {
		const response = await app.request('http://sms.test/api/client/phone-bind.php', {
			method: 'POST',
			// text/plain 正是这套协议的关键：浏览器按 CORS 简单请求发，不触发预检。
			headers: { 'content-type': 'text/plain', ...(extra.headers ?? {}) },
			body: ticket.rawBody,
		});
		const json = await response.json().catch(() => ({}));
		return { status: response.status, message: json.feedback?.message ?? '', data: json };
	};

	/**
	 * ---- 跨源：接入方从自己的页面提交票据 ----
	 *
	 * 预检过不了的话，浏览器根本不会把真正那一发请求送出来——接入方在控制台看到的是
	 * 一句 CORS 错误，而服务端日志里一片空白，最难查的一类问题。
	 */
	const preflight = await app.request('http://sms.test/api/client/phone-bind.php', {
		method: 'OPTIONS',
		headers: { origin: 'https://client.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
	});
	assert.equal(preflight.status, 204);
	assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
	const allowedHeaders = String(preflight.headers.get('access-control-allow-headers'));
	assert.match(allowedHeaders, /content-type/, '预检要放行 content-type');
	// 带凭证的跨源请求一律不放行：放行了浏览器就会附带 cookie，而这条链的凭证只能是签名。
	assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
	// 预检结果要肯让浏览器缓存：这几个头一年也不会变一次，而每次预检都是一个真实往返。
	assert.equal(preflight.headers.get('access-control-max-age'), '86400');
	// Allow-Headers 是照着请求回声的，因此这条响应随请求头而变；中间有缓存时不声明会串味。
	assert.match(String(preflight.headers.get('vary')), /Origin/i, '预检要声明 Vary');

	/**
	 * **接入方多带一个头也要过。**
	 *
	 * 原先 Allow-Headers 是一份写死的白名单，只列了这条协议自己用的五个头。接入方的页面
	 * 多带一个链路追踪的 traceparent、或者框架自动加的 x-requested-with，预检就过不了，
	 * 而他在控制台看到的只是一句 CORS 错误，服务端日志里一片空白——最难查的那一类。
	 */
	const extraHeaderPreflight = await app.request('http://sms.test/api/client/phone-bind.php', {
		method: 'OPTIONS',
		headers: { origin: 'https://client.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, traceparent, x-requested-with' },
	});
	assert.equal(extraHeaderPreflight.status, 204);
	assert.match(String(extraHeaderPreflight.headers.get('access-control-allow-headers')), /traceparent/, '接入方问什么头就放什么头');

	/**
	 * **用错方法要回确定性的 405，不是 500。**
	 *
	 * 叶子对非 POST 只是 `return next()`，而它后面已经没有处理者了——不在门口收口的话
	 * 出来的是 500「API route did not return a response」。对接的人拿到 500 会去查我们的
	 * 服务是不是挂了，而真相只是他用错了方法。
	 */
	for (const method of ['GET', 'PUT', 'DELETE']) {
		const wrongMethod = await app.request('http://sms.test/api/client/phone-bind.php', { method, headers: { origin: 'https://client.example.com' } });
		assert.equal(wrongMethod.status, 405, `${method} 要回 405，不能是内部异常`);
		assert.match(String(wrongMethod.headers.get('allow')), /POST/, `${method} 的 405 要告诉对方该用什么方法`);
		// 错误响应也得带 CORS 头，浏览器才读得到这句提示；不带的话对方只看得见一句 CORS 错误。
		assert.equal(wrongMethod.headers.get('access-control-allow-origin'), '*', `${method} 的错误响应也要带 CORS 头`);
	}

	// ---- 失败规则（§7.2）：每一条都得回确定性错误，而不是内部异常 ----
	// 用一个一次性会话测：会话层看到只带 cookie、不带设备头的请求会当成盗用，把会话吊销——
	// 拿主会话测的话，后面所有用它的请求都会变成「请先登录」。
	const burner = await signIn('ticketadmin');
	assert.match((await bind(makeTicket(), { headers: { cookie: burner.cookie } })).message, /cookie/, '带 cookie 要拒：浏览器会自动附带它，认了就等于任何网页都能借用户身份来打');

	// 完全不带这四个头——模拟照着老文档写的代码原样打过来，一个头都没有。缺失了哪个头
	// 要说得很直白，第一个检查到的字段决定了提示，不需要额外识别"这看起来像老格式"。
	const legacyRequest = await app.request('http://sms.test/api/client/phone-bind.php', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ phone: '+8613800138000' }) });
	assert.equal(legacyRequest.status, 400);
	assert.match(String((await legacyRequest.json()).feedback?.message), /publicKey/, '照老协议打过来的请求，第一句就要点出信封里缺了什么');


	/**
	 * ---- 信封本身的规矩 ----
	 *
	 * 这套协议的全部价值在于「签的字节 = 发的字节」。下面几条守的就是它。
	 */
	const raw = (body) => app.request('http://sms.test/api/client/phone-bind.php', { method: 'POST', headers: { 'content-type': 'text/plain' }, body })
		.then(async (response) => ({ status: response.status, message: String((await response.json().catch(() => ({}))).feedback?.message ?? '') }));

	// payload 传成嵌套对象是最容易犯的错：那样服务端要验签就得把它重新序列化回字符串，
	// 而两边不可能保证序列化一致。这里必须当场说清楚，而不是回一句「签名无效」让人去查私钥。
	const nested = await raw(JSON.stringify({ publicKey: live.publicKey, signature: 'ed25519=x', payload: { ts: Math.floor(Date.now() / 1000), phone: '+8613800138000' } }));
	assert.equal(nested.status, 400);
	assert.match(nested.message, /payload 必须是一段 JSON 字符串/, 'payload 传成对象要当场点破，不能报成签名无效');

	// 改 payload 里任何一个字符，签名都必须当场失效——包括原先没被签住的 nonce。
	const tampered = makeTicket({ phone: '+8613800138000' });
	const tamperedEnvelope = JSON.parse(tampered.rawBody);
	tamperedEnvelope.payload = tamperedEnvelope.payload.replace('+8613800138000', '+8613800138001');
	assert.match((await raw(JSON.stringify(tamperedEnvelope))).message, /签名无效/, '改了 payload 签名就必须失效');

	const nonceTampered = JSON.parse(makeTicket().rawBody);
	nonceTampered.payload = nonceTampered.payload.replace(/"nonce":"[^"]+"/, '"nonce":"someone-elses-nonce"');
	assert.match((await raw(JSON.stringify(nonceTampered))).message, /签名无效/, 'nonce 现在也在签名范围内——老协议里它走请求头，一个字节都没被签');

	// ts 和 nonce 都在 payload 里，缺一个都要说清楚缺的是哪个。
	assert.match((await bind(makeTicket({ nonce: '' }))).message, /nonce/, 'nonce 为空要点名');
	assert.match((await bind(makeTicket({}, { timestamp: Math.floor(Date.now() / 1000) - 3600 }))).message, /过期|相差/, '一小时前签的票据不能用');

	const stranger = keypair();
	assert.match((await bind(makeTicket({}, { publicKeyHeader: stranger.publicKey, privateKey: stranger.privateKey }))).message, /没有登记/, '没登记过的公钥，签名再正确也不认');
	assert.match((await bind(makeTicket({}, { publicKeyHeader: retired.publicKey, privateKey: retired.privateKey }))).message, /没有登记|退役/, '退役的公钥要立刻拒新请求');
	assert.match((await bind(makeTicket({}, { publicKeyHeader: readOnly.publicKey, privateKey: readOnly.privateKey }))).message, /权限/, '没有 phone:bind 的接入方绑不了');
	// **冒充的唯一形态**：声明别人的公钥。声明了就得拿别人的私钥来签，而私钥不出签发方的门。
	assert.match((await bind(makeTicket({}, { privateKey: keypair().privateKey }))).message, /签名无效/, '声明的公钥与实际签名的私钥对不上要验不过');
	assert.match((await bind(makeTicket({}, { publicKeyHeader: 'not-a-valid-key' }))).message, /publicKey/);

	const expired = Math.floor(Date.now() / 1000) - 600;
	assert.match((await bind(makeTicket({}, { timestamp: expired }))).message, /过期|生效/, '太旧的时间戳要拒——固定 60 秒容差，不再由调用方声明有效期');
	const future = Math.floor(Date.now() / 1000) + 600;
	assert.match((await bind(makeTicket({}, { timestamp: future }))).message, /过期|生效/, '太超前的时间戳同样要拒，不只挡过去那一侧');
	assert.match((await bind(makeTicket({ phone: '不是号码' }))).message, /号码格式/);

	// ---- 正常绑定 ----
	const ticket = makeTicket({ title: '客户的机器' });
	const bound = await bind(ticket);
	assert.equal(bound.status, 200, bound.message);
	assert.equal(bound.data.already_bound, false);
	assert.equal(bound.data.number, '+8613800138000');

	const afterBind = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	const phone = afterBind.prepare("SELECT * FROM sms_phones WHERE number = '+8613800138000'").get();
	assert.ok(phone, '手机要建出来');
	// 归属必须显式绑上：这条路径没有本站会话，不绑的话 owner_uid 会是 NULL，
	// 而 NULL 归属的行普通账号一律看不见——用户自己看不到自己刚绑的手机。
	assert.equal(String(phone.owner_uid), String(ownerId), 'owner_uid 要落成票据里的账号');
	// 关联的项目由服务端从票据的 client_id 写入，不由调用方指定——它决定了短信将来推给谁。
	assert.equal(String(phone.integration_client_id), String(client.id));
	assert.equal(phone.title, '客户的机器');
	assert.equal(phone.status, 'enabled');
	assert.equal(afterBind.prepare("SELECT COUNT(*) AS n FROM sms_shortcut_tokens WHERE status = 'bound' AND phone_id = ?").get(phone.id).n, 1, '要领到一把令牌——没有令牌的手机一条短信也收不到');
	assert.equal(afterBind.prepare('SELECT COUNT(*) AS n FROM sms_ticket_nonces').get().n, 1);
	afterBind.close();

	// ---- nonce 一次性：同一张票据再来一次要拒 ----
	const replayed = await bind(ticket);
	assert.equal(replayed.status, 409, '重放要拒');
	assert.match(replayed.message, /已经用过/);

	// ---- 幂等：换一张新票据绑同一个号码，回成功但不新建记录 ----
	const again = await bind(makeTicket());
	assert.equal(again.status, 200, again.message);
	assert.equal(again.data.already_bound, true, '已经绑过了要回幂等成功，而不是报错');
	const afterRepeat = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	assert.equal(afterRepeat.prepare("SELECT COUNT(*) AS n FROM sms_phones WHERE number = '+8613800138000'").get().n, 1, '不产生重复记录');
	assert.equal(afterRepeat.prepare("SELECT COUNT(*) AS n FROM sms_shortcut_tokens WHERE status = 'bound'").get().n, 1, '也不该再领一把令牌');
	afterRepeat.close();

	/**
	 * ---- 下载文件名：接入方可以自己指定 ----
	 *
	 * 断言落在**存进库的那个值**上，而不是下载地址：这份测试没配对象存储，`download_url`
	 * 恒为 null。而存库的那个值才是决定"以后每一次签发用什么名字"的东西——链接 15 分钟过期
	 * 之后接入方会再要一次，控制台也能再下一次，名字得始终是同一个。
	 */
	const storedFilename = (key) => {
		const db = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
		const row = db.prepare('SELECT filename FROM sms_phones WHERE key = ?').get(key);
		db.close();
		return row?.filename ?? null;
	};

	await bind(makeTicket({ phone: '+8613700137001', key: 'fn-plain', filename: '银行到账自动确认-8888.shortcut' }));
	assert.equal(storedFilename('fn-plain'), '银行到账自动确认-8888.shortcut', '指定的文件名要原样存下来');

	// 后缀强制补上：iOS 靠后缀决定用「快捷指令」打开，叫成别的名字用户点开只会看到乱码。
	await bind(makeTicket({ phone: '+8613700137002', key: 'fn-noext', filename: '到账提醒' }));
	assert.equal(storedFilename('fn-noext'), '到账提醒.shortcut');
	await bind(makeTicket({ phone: '+8613700137003', key: 'fn-otherext', filename: '到账提醒.txt' }));
	assert.equal(storedFilename('fn-otherext'), '到账提醒.txt.shortcut', '别的后缀不删，补上 .shortcut——删了就可能把名字改成他没要的样子');

	// 目录分隔符要去掉：带路径的名字进到 Content-Disposition 里，各家客户端保存行为不一致。
	await bind(makeTicket({ phone: '+8613700137004', key: 'fn-path', filename: '../../etc/passwd.shortcut' }));
	assert.equal(storedFilename('fn-path'), '....etcpasswd.shortcut');

	// 不传就是"没指定"，按接入方标题加号码后四位推导（见 binding.mts）。
	await bind(makeTicket({ phone: '+8613700137005', key: 'fn-absent' }));
	assert.equal(storedFilename('fn-absent'), '', '不传时不写入，留给推导');

	/**
	 * **同一个 key 后续不传 filename，不能把已存的名字抹掉。**
	 *
	 * 接入方第二次调用往往只是"再要一次下载地址"，请求体未必带齐。抹掉的话，客户手里那条
	 * 链接的文件名会莫名其妙变回推导值，而接入方完全不知道自己做了这件事。
	 */
	await bind(makeTicket({ phone: '+8613700137001', key: 'fn-plain' }));
	assert.equal(storedFilename('fn-plain'), '银行到账自动确认-8888.shortcut', '重复调用不带 filename 时要保留原值');

	// ---- 号码归一：11 位裸号与 +86 形态是同一部手机 ----
	const bare = await bind(makeTicket({ phone: '13800138000' }));
	assert.equal(bare.data.already_bound, true, '裸 11 位要归一成 +86，否则同一个号会绑成两部手机、短信各进各的');

	/**
	 * ---- 换发：原来的快捷指令失效之后重绑 ----
	 *
	 * 幂等说的是「保证这个号有一份能用的快捷指令」，不是「记录在就算完」。管理员清空令牌池
	 * 重新生成之后，手机记录还在、令牌没了——这时只回「已经绑过了」、下载地址为空，用户
	 * 手里就没有任何出路（重绑被幂等挡住）。实际发生过。
	 */
	const liveTokens = () => {
		const read = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
		const count = read.prepare("SELECT COUNT(*) AS n FROM sms_shortcut_tokens WHERE phone_id = ? AND status = 'bound' AND deleted_at = 0").get(phone.id).n;
		read.close();
		return count;
	};
	const tamper = (statement) => { const write = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE); write.prepare(statement).run(Date.now()); write.close(); };
	tamper(`UPDATE sms_shortcut_tokens SET deleted_at = ? WHERE phone_id = ${phone.id}`);
	assert.equal(liveTokens(), 0);
	const reissued = await bind(makeTicket());
	assert.equal(reissued.status, 200, reissued.message);
	assert.equal(reissued.data.already_bound, true, '手机记录还是原来那条，不新建');
	assert.equal(reissued.data.reissued, true, '令牌被删了要换发一份，不能只回「已经绑过了」');
	assert.match(reissued.message, /失效/);
	assert.equal(liveTokens(), 1, '同一部手机挂上了新令牌');
	// 令牌已经在了：再绑只是重取下载地址，不再换发、不再从池子里领
	const steady = await bind(makeTicket());
	assert.equal(steady.data.reissued, false, '令牌还在就不换发');
	assert.equal(liveTokens(), 1);
	// 被撤销（没删）同样算失效：撤销的令牌接收接口会拒，装着它的快捷指令一样用不了
	tamper(`UPDATE sms_shortcut_tokens SET status = 'revoked', updated_at = ? WHERE phone_id = ${phone.id} AND deleted_at = 0`);
	assert.equal((await bind(makeTicket())).data.reissued, true, '被撤销的也要换发');
	assert.equal(liveTokens(), 1);

	/**
	 * ---- 解绑之后重新绑定：复用那一行 ----
	 *
	 * 解绑不是删除，那一行还占着唯一索引。以前照常新建、撞索引、落进「刚被抢先」那条分支，
	 * 找回来的正是这条已解绑的记录，下载地址为空——线上实际发生过。
	 */
	const phonesUrl = 'http://sms.test/api/panel/user/sms/phones.php';
	const unbound = await app.request(`${phonesUrl}/${phone.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ status: 'revoked' }) });
	assert.equal(unbound.status, 200, '解绑');
	const readPhone = (sql, ...args) => { const read = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true }); const row = read.prepare(sql).get(...args); read.close(); return row; };
	const oldTokenId = readPhone("SELECT id FROM sms_shortcut_tokens WHERE phone_id = ? AND status = 'bound' AND deleted_at = 0", phone.id).id;
	const rebound = await bind(makeTicket());
	assert.equal(rebound.status, 200, rebound.message);
	assert.equal(rebound.data.already_bound, false, '解绑之后重绑就是一次新的绑定');
	assert.equal(readPhone('SELECT status FROM sms_phones WHERE id = ?', phone.id).status, 'enabled', '复用原来那一行，改回正常接收');
	assert.equal(readPhone("SELECT COUNT(*) AS n FROM sms_phones WHERE number = '+8613800138000' AND owner_uid = ? AND deleted_at = 0", ownerId).n, 1, '不新建一行');
	// 旧令牌要作废：手机一改回正常接收，旧的快捷指令不能跟着复活
	assert.equal(readPhone('SELECT status FROM sms_shortcut_tokens WHERE id = ?', oldTokenId).status, 'revoked', '旧令牌要作废');
	assert.equal(liveTokens(), 1, '挂上了一个新令牌');

	/**
	 * ---- 删除之后重新绑定：新的一行 ----
	 *
	 * 唯一索引带 deleted_at，删掉的那一行不再占着号码。
	 */
	const removed = await app.request(`${phonesUrl}/${phone.id}`, { method: 'DELETE', headers: h });
	assert.equal(removed.status, 200, '删除');
	const fresh = await bind(makeTicket());
	assert.equal(fresh.status, 200, fresh.message);
	assert.equal(fresh.data.already_bound, false);
	const freshPhone = readPhone("SELECT id FROM sms_phones WHERE number = '+8613800138000' AND owner_uid = ? AND deleted_at = 0", ownerId);
	assert.notEqual(String(freshPhone.id), String(phone.id), '删掉之后重绑是新的一行');
	assert.equal(readPhone("SELECT COUNT(*) AS n FROM sms_shortcut_tokens WHERE phone_id = ? AND status = 'bound' AND deleted_at = 0", freshPhone.id).n, 1);

	/**
	 * ---- 归属由公钥决定 ----
	 *
	 * 这是整套简化的立足点：以前 `base_user_id` 由调用方填，于是要额外查一道「这个账号是不是
	 * 你名下的」；现在账号从公钥反查出来，**填错和越权都不再是可能的形态**。
	 *
	 * 另一个人用自己的钥匙绑同一个号码：拿到的是**他自己名下**的一行，与前面那一行互不相干
	 * （手机往往是客户的，两家服务商服务同一位客户是常事）。
	 */
	const otherSession = await signIn('ticketother');
	const otherCreated = await app.request('http://sms.test/api/panel/user/sms/integration-clients.php', { method: 'POST', headers: otherSession, body: JSON.stringify({ name: 'otherclient', title: '另一家', binding_scope: ['phone:bind'], status: 'enabled' }) });
	assert.equal(otherCreated.status, 201);
	const otherClient = (await (await app.request('http://sms.test/api/panel/user/sms/integration-clients.php?include=data', { headers: otherSession })).json()).table.dataSource.find((row) => row.name === 'otherclient');
	const otherKey = keypair();
	assert.equal((await registerKey(otherClient.id, 'k-other', otherKey.publicKey, otherSession)).status, 201);

	const otherBound = await bind(makeTicket({}, { publicKeyHeader: otherKey.publicKey, privateKey: otherKey.privateKey }));
	assert.equal(otherBound.status, 200, otherBound.message);
	assert.equal(otherBound.data.already_bound, false, '另一家是全新的一行，不是幂等命中');

	const isolated = new DatabaseSync(process.env.DEFAULT_DATABASE_FILE, { readOnly: true });
	const rows = isolated.prepare("SELECT owner_uid, integration_client_id FROM sms_phones WHERE number = '+8613800138000' AND deleted_at = 0 ORDER BY id").all();
	assert.equal(rows.length, 2, '两个人各一行');
	assert.equal(String(rows[0].owner_uid), String(ownerId));
	assert.equal(String(rows[0].integration_client_id), String(client.id));
	// 归属**没有**跟着第一家走：它是从第二把公钥反查出来的。
	assert.equal(String(rows[1].owner_uid), String(otherId), '手机要落在这把公钥的主人名下');
	assert.equal(String(rows[1].integration_client_id), String(otherClient.id));
	isolated.close();

	/**
	 * ---- key：接入方自己指定行标识，驱动去重（不传 key 时退回按号码去重） ----
	 *
	 * 用一批全新号码测，避免和前面那部手机复杂的绑定/换发/删除历史状态搅在一起。
	 */
	const refPhone = '+8613900000001';
	const bare1 = await bind(makeTicket({ phone: refPhone }));
	assert.equal(bare1.status, 200, bare1.message);
	assert.equal(bare1.data.client_ref, null, '不传 client_ref，回显也是 null');

	// 不传 key：退回按号码去重，行为与这次改动之前完全一样——重复绑同一个号是幂等。
	const bareAgain = await bind(makeTicket({ phone: refPhone }));
	assert.equal(bareAgain.data.already_bound, true, '不传 key 时仍然按号码去重');
	assert.equal(readPhone("SELECT COUNT(*) AS n FROM sms_phones WHERE number = ? AND owner_uid = ? AND integration_client_id = ? AND deleted_at = 0", refPhone, ownerId, client.id).n, 1);

	/**
	 * 传了 key：**完全走另一套去重**，只认 key，不看号码——同一个号码可以在同一个接入方
	 * 名下开出好几行，只要 key 不同。
	 */
	const keyedPhone = '+8613900000002';
	const keyed = await bind(makeTicket({ phone: keyedPhone, key: 'order-A', client_ref: 'ref-A' }));
	assert.equal(keyed.status, 200, keyed.message);
	assert.equal(keyed.data.already_bound, false, '新 key，全新一行');
	assert.equal(keyed.data.client_ref, 'ref-A');
	// 号码路径那条查重没受影响：refPhone 依旧只有一行，keyedPhone 是另一部手机、另一行。
	assert.equal(readPhone("SELECT COUNT(*) AS n FROM sms_phones WHERE key = 'order-A'").n, 1);
	assert.equal(readPhone("SELECT COUNT(*) AS n FROM sms_phones WHERE number = ? AND deleted_at = 0", refPhone).n, 1, '号码驱动那一行没受影响');

	// 同一个 key 再绑一次：幂等，直接给原来那份快捷指令，不提示重复——「反正就是他的」。
	const keyedRepeat = await bind(makeTicket({ phone: keyedPhone, key: 'order-A' }));
	assert.equal(keyedRepeat.data.already_bound, true, '同一个 key 重复绑定要幂等');
	// download_url 这份测试文件没配对象存储，恒为 null——那条路径由 test-sms-push.mjs 覆盖。
	assert.equal(readPhone("SELECT COUNT(*) AS n FROM sms_phones WHERE key = 'order-A'").n, 1, '幂等命中不新建行');

	// 同一个 key，换一个号码再绑：命中同一行，号码要跟着更新（同一个身份，号码是它的属性）。
	const rebindNumber = '+8613900000003';
	const keyedRebound = await bind(makeTicket({ phone: rebindNumber, key: 'order-A' }));
	assert.equal(keyedRebound.status, 200, keyedRebound.message);
	assert.equal(readPhone("SELECT number FROM sms_phones WHERE key = 'order-A'").number, rebindNumber, '同一个 key，号码要同步成最新提交的那个');

	// 跨接入方撞 key：不是自己的，拒绝——且不透露占用者的任何信息。
	const crossTenantKey = await bind(makeTicket({ phone: '+8613900000004', key: 'order-A' }, { publicKeyHeader: otherKey.publicKey, privateKey: otherKey.privateKey }));
	assert.equal(crossTenantKey.status, 409);
	assert.match(crossTenantKey.message, /已经被占用/);
	assert.equal(String(readPhone("SELECT owner_uid FROM sms_phones WHERE key = 'order-A'").owner_uid), String(ownerId), '归属没有被跨接入方的请求改动');

	// key 格式不对：直接拒绝，不让它撞进数据库层的裸错误。
	const badKey = await bind(makeTicket({ phone: '+8613900000005', key: '带着空格和中文的 key' }));
	assert.equal(badKey.status, 400);
	assert.match(badKey.message, /标识格式不对/);

	/**
	 * ---- 推送时把 client_ref 原样带回（不管走的是哪条去重路径） ----
	 *
	 * 这是 client_ref 这个字段存在的目的：接入方不一定按手机号存自己的客户，短信到达时
	 * 要靠这个值对回自己那边的记录，而不是靠手机号。
	 */
	const keyedPhoneId = readPhone("SELECT id FROM sms_phones WHERE key = 'order-A'").id;
	const keyedToken = readPhone("SELECT token_sha256 FROM sms_shortcut_tokens WHERE phone_id = ? AND status = 'bound'", keyedPhoneId).token_sha256;
	assert.ok(keyedToken, '要能查到这部手机挂着的令牌');
	assert.equal(readPhone("SELECT client_ref FROM sms_phones WHERE id = ?", keyedPhoneId).client_ref, 'ref-A');

	// 「我的手机」页面也要看得到这个引用——不用只查数据库才知道哪部手机对应哪个客户。
	const myPhonesList = await (await app.request('http://sms.test/api/panel/user/sms/phones.php?include=data', { headers: h })).json();
	const keyedPhoneRow = myPhonesList.table.dataSource.find((row) => String(row.id) === String(keyedPhoneId));
	assert.equal(keyedPhoneRow.client_ref, 'ref-A');

	console.log('sms ticket bind test passed');
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
