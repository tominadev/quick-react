const styles = `
html, body { margin: 0; min-height: 100%; font-family: system-ui, -apple-system, sans-serif; }
body { min-height: 100vh; display: grid; place-items: center; background: #405a75; color: #d8e5f0; }
.card { width: min(420px, calc(100% - 48px)); padding: 30px 26px; text-align: center; border: 1px solid #607992; border-radius: 16px; background: #536d88; box-shadow: 0 16px 42px #13233455; }
h2 { margin: 0 0 18px; color: #f2f7fb; font-size: 20px; }
#qr { display: inline-block; margin: 10px auto 20px; padding: 10px; background: #fff; border-radius: 8px; }
.message { margin: 12px 0; color: #d8e5f0; }
.error { color: #ffd6d6; }
.hidden { display: none; }
input { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid #9eb2c5; border-radius: 6px; background: #eef4f8; color: #1d2a38; font-size: 15px; }
button { margin: 8px 4px; padding: 9px 16px; border: 0; border-radius: 6px; background: #dcebf7; color: #29415a; cursor: pointer; font-size: 14px; }
button.primary { background: #f2f7fb; }
button:disabled { opacity: .6; cursor: not-allowed; }
.row { display: flex; gap: 8px; }
.row input { flex: 1; }
.row button { white-space: nowrap; }
`;

export const renderWechatQrPage = (apiPath: string, signPath: string, popup: boolean) => {
	const api = JSON.stringify(apiPath);
	const sign = JSON.stringify(signPath);
	const popupFlag = popup ? 'true' : 'false';
	return `<!doctype html>
<html lang="zh-CN">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>微信扫码登录</title>
		<style>${styles}</style>
	</head>
	<body>
		<main class="card">
			<h2>微信扫码登录</h2>
			<div id="qr"></div>
			<p id="message" class="message">正在获取二维码…</p>
			<section id="email" class="hidden">
				<p>微信身份已确认，请输入用于 Accounts 的邮箱。</p>
				<div class="row">
					<input id="emailInput" type="email" placeholder="请输入邮箱">
					<button id="send" class="primary">发送验证码</button>
				</div>
			</section>
			<section id="code" class="hidden">
				<p id="codeMessage"></p>
				<div class="row">
					<input id="codeInput" inputmode="numeric" maxlength="6" placeholder="请输入 6 位验证码">
					<button id="verify" class="primary">验证邮箱</button>
				</div>
				<button id="change">更换邮箱</button>
			</section>
			<div>
				<button id="refresh" class="hidden">刷新二维码</button>
				<button id="fallback" class="hidden">更换邮箱或使用 Google 登录</button>
			</div>
		</main>
		<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
		<script src="/passport.js.nocache"></script>
		<script>
			const api = ${api};
			const sign = ${sign};
			const popup = ${popupFlag};
			let pollTimer;
			let bindUrl = '';

			const element = (id) => document.getElementById(id);
			const requestHeaders = (init = {}) => {
				if (!window.Passport?.getDeviceHeaders) throw new Error('设备标识脚本加载失败，请刷新页面后重试');
				return window.Passport.getDeviceHeaders(init);
			};
			const show = (id, visible) => element(id).classList.toggle('hidden', !visible);
			const setMessage = (text, error = false) => {
				element('message').textContent = text;
				element('message').className = 'message' + (error ? ' error' : '');
			};
			const stopPolling = () => {
				if (pollTimer) window.clearInterval(pollTimer);
				pollTimer = undefined;
			};

			async function loadQr() {
				stopPolling();
				show('refresh', false); show('fallback', false); show('email', false); show('code', false);
				element('qr').innerHTML = ''; setMessage('正在获取二维码…');
				try {
					const response = await fetch(api + '?format=json' + (popup ? '&popup=1' : ''), { headers: await requestHeaders(), credentials: 'include' });
					const data = await response.json();
					if (!response.ok) throw new Error(data.feedback?.message || data.message || '获取二维码失败');
					new QRCode(element('qr'), data.authorizationUrl); setMessage('请使用微信扫描二维码');
					if (data.fallbackUrl) { element('fallback').onclick = () => window.location.assign(data.fallbackUrl); show('fallback', true); }
					pollTimer = window.setInterval(async () => {
						try {
							const poll = await (await fetch(data.pollUrl, { headers: await requestHeaders(), credentials: 'include' })).json();
							if (poll.status === 'authenticated') { stopPolling(); window.location.assign(poll.redirectTo || '/'); }
							else if (poll.status === 'needs_email') { stopPolling(); bindUrl = poll.bindUrl; show('qr', false); show('email', true); setMessage('微信身份已确认，请验证邮箱'); }
							else if (poll.status === 'expired') { stopPolling(); show('refresh', true); setMessage('二维码已失效，请刷新后重新扫码', true); }
							else if (poll.status === 'error') { stopPolling(); show('refresh', true); setMessage(poll.error || '登录失败，请刷新二维码后重试', true); }
						} catch { stopPolling(); show('refresh', true); setMessage('轮询二维码状态失败，请刷新二维码后重试', true); }
					}, 2000);
				} catch (error) { show('refresh', true); setMessage(error.message || '获取二维码失败', true); }
			}

			element('refresh').onclick = loadQr;
			element('fallback').onclick = () => window.location.assign(sign);
			element('send').onclick = async () => {
				const email = element('emailInput').value.trim();
				if (!email) { setMessage('请输入邮箱', true); return; }
				if (!window.confirm('验证码将发送到：' + email + '\\n请确认邮箱地址正确。')) return;
				const response = await fetch(bindUrl, { method: 'POST', headers: await requestHeaders({ 'content-type': 'application/json' }), credentials: 'include', body: JSON.stringify({ step: 'email', email }) });
				const data = await response.json();
				if (!response.ok) { setMessage(data.feedback?.message || '验证码发送失败', true); return; }
				show('email', false); show('code', true); element('codeMessage').textContent = '请到 ' + email + ' 查收邮件，验证码已发送到该地址。';
			};
			element('change').onclick = () => { show('code', false); show('email', true); element('emailInput').focus(); };
			element('verify').onclick = async () => {
				const code = element('codeInput').value.trim();
				if (!/^\\d{6}$/.test(code)) { setMessage('请输入 6 位数字验证码', true); return; }
				element('verify').disabled = true;
				const response = await fetch(bindUrl, { method: 'POST', headers: await requestHeaders({ 'content-type': 'application/json' }), credentials: 'include', body: JSON.stringify({ step: 'verify', code }) });
				const data = await response.json();
				if (!response.ok) { setMessage(data.feedback?.message || '邮箱验证失败', true); element('verify').disabled = false; return; }
				window.location.assign(data.redirectTo || '/');
			};
			loadQr();
		</script>
	</body>
</html>`;
};
