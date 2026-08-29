import { escapeHtml } from '@server/utils/html.mjs';

export const renderExternalRedirect = (targetUrl: string, title: string, description = '请稍候，页面即将跳转…') => {
	const target = JSON.stringify(targetUrl).replaceAll('<', '\\u003c');
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>${escapeHtml(title)}</title>
	<style>
		html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,sans-serif}
		body{min-height:100vh;display:grid;place-items:center;background:#405a75;color:#d8e5f0}
		.card{width:min(320px,calc(100% - 48px));padding:32px 28px;text-align:center;border:1px solid #607992;border-radius:16px;background:#536d88;box-shadow:0 16px 42px #13233455}
		.spinner{width:32px;height:32px;margin:0 auto 16px;border:3px solid #dcebf74d;border-top-color:#f2f7fb;border-radius:50%;animation:spin .75s linear infinite}
		strong{display:block;color:#f2f7fb;font-size:17px;font-weight:600}p{margin:8px 0 0;color:#d8e5f0;font-size:14px}
		@keyframes spin{to{transform:rotate(360deg)}}
	</style>
</head>
<body>
	<main class="card" role="status" aria-live="polite"><div class="spinner" aria-hidden="true"></div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></main>
	<script>location.href=${target};</script>
</body>
</html>`;
};
