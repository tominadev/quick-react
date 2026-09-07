import { html, raw } from 'hono/html';
import type { InitialData } from '@shared/types/initial-data.mjs';
import { webClientFor } from '@shared/web-clients.mjs';

interface IndexData {
	title: string;
	description: string;
	canonical?: string;
	/** 加载失败时给用户的联系方式；没配置就只提示刷新。 */
	contactEmail?: string;
	initialData: InitialData;
	/**
	 * 这个域名用哪一套前端（`shared/web-clients.mts` 的 key）。空串或认不出的值回落到默认
	 * 那一套——这一步一旦拿不到结果，整个域名就打不开。
	 */
	clientKey?: string;
}

/**
 * 页面壳的兜底：脚本没能把界面渲染出来时，别让用户对着「正在加载页面…」干等。
 *
 * 三种失败各有各的信号，都要盖住：
 * - 脚本压根没加载到（404、断网、CDN 挂了）——`onerror`，这是确定性的失败。
 * - 脚本加载了但初始化就抛错（浏览器太旧、代码有 bug）——`window.onerror`。
 * - 什么信号都没有，就是一直不出来——超时兜底，措辞用「超时」而不是「失败」，
 *   因为慢网络下它可能还在下载。
 *
 * 整段不依赖任何外部资源：能走到这里，恰恰说明外部资源靠不住。
 */
const failureScript = (contactEmail: string) => `
(function () {
	var handled = false;
	function fail(title, detail) {
		if (handled) return;
		var root = document.getElementById('root');
		// 界面已经渲染出来了就别打扰：迟到的错误信号不该盖掉一个正常工作的页面。
		if (!root || !root.querySelector('.app-loading')) return;
		handled = true;
		var card = document.createElement('div');
		card.className = 'app-loading-card';
		var heading = document.createElement('strong');
		heading.textContent = title;
		card.appendChild(heading);
		var hint = document.createElement('span');
		hint.className = 'app-loading-plain';
		hint.textContent = detail;
		card.appendChild(hint);
		var contact = ${JSON.stringify(contactEmail)};
		if (contact) {
			var line = document.createElement('span');
			line.className = 'app-loading-plain';
			line.appendChild(document.createTextNode('如果反复出现，请联系客服：'));
			var link = document.createElement('a');
			link.href = 'mailto:' + contact;
			link.textContent = contact;
			line.appendChild(link);
			card.appendChild(line);
		} else {
			var plain = document.createElement('span');
			plain.className = 'app-loading-plain';
			plain.textContent = '如果反复出现，请联系客服。';
			card.appendChild(plain);
		}
		var retry = document.createElement('button');
		retry.type = 'button';
		retry.className = 'app-loading-retry';
		retry.textContent = '重新加载';
		retry.onclick = function () { window.location.reload(); };
		card.appendChild(retry);
		var wrapper = document.createElement('div');
		wrapper.className = 'app-loading';
		wrapper.setAttribute('role', 'alert');
		wrapper.appendChild(card);
		root.innerHTML = '';
		root.appendChild(wrapper);
	}
	window.__APP_LOAD_FAILED__ = function () { fail('页面加载失败', '没能加载页面所需的程序文件，请检查网络后重试。'); };
	window.addEventListener('error', function () { fail('页面加载失败', '页面程序启动时出错了，请重试。'); });
	window.setTimeout(function () { fail('页面加载超时', '等待时间过长，可能是网络较慢。'); }, 30000);
})();
`.trim();

export const renderIndexHtml = (data: IndexData) => {
	const initialDataJson = JSON.stringify(data.initialData).replaceAll('<', '\\u003c');
	const client = webClientFor(data.clientKey);
	return html`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${data.title}</title>
  <meta name="description" content="${data.description}">
  ${data.canonical ? html`<link rel="canonical" href="${data.canonical}">` : ''}
  <meta property="og:title" content="${data.title}">
  <meta property="og:description" content="${data.description}">
  <meta property="og:type" content="website">
  ${client.stylesheet ? html`<link rel="stylesheet" href="/${client.stylesheet}">` : ''}
</head>
<body>
  <div id="root">
    <div class="app-loading" role="status" aria-live="polite">
      <div class="app-loading-card">
        <div class="app-loading-spinner" aria-hidden="true"></div>
        <strong>${data.initialData.siteName}</strong>
        <span>正在加载页面…</span>
        <div class="app-loading-progress" role="progressbar" aria-label="页面加载中"><i></i></div>
      </div>
    </div>
  </div>
  <style>
    html, body { margin: 0; min-height: 100%; }
    .app-loading { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #405a75; color: #d8e5f0; font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .app-loading-card { min-width: 210px; padding: 34px 42px 30px; display: flex; flex-direction: column; align-items: center; gap: 9px; border: 1px solid rgba(225, 239, 250, .22); border-radius: 20px; background: rgba(67, 92, 119, .88); box-shadow: 0 16px 42px rgba(19, 35, 52, .28); }
    .app-loading-card strong { max-width: 240px; overflow: hidden; color: #f2f7fb; font-size: 18px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
    .app-loading-spinner { width: 34px; height: 34px; margin-bottom: 8px; border: 3px solid rgba(220, 235, 247, .3); border-top-color: #f2f7fb; border-radius: 50%; animation: app-loading-spin .75s linear infinite; }
    .app-loading-card span::after { display: inline-block; width: 18px; text-align: left; content: ''; animation: app-loading-dots 1.4s steps(4, end) infinite; }
    .app-loading-progress { width: 100%; height: 4px; margin-top: 7px; overflow: hidden; border-radius: 999px; background: rgba(220, 235, 247, .25); }
    .app-loading-progress i { display: block; width: 42%; height: 100%; border-radius: inherit; background: #c4e2f8; box-shadow: 0 0 10px rgba(196, 226, 248, .45); animation: app-loading-progress 1.35s ease-in-out infinite; }
    /* 失败提示复用同一张卡片，只是不再有旋转和进度条；文字不带省略号动画。 */
    .app-loading-plain { max-width: 280px; text-align: center; }
    .app-loading-plain::after { content: none !important; animation: none !important; }
    .app-loading-plain a { color: #c4e2f8; }
    .app-loading-retry { margin-top: 6px; padding: 6px 18px; border: 1px solid rgba(225, 239, 250, .35); border-radius: 999px; background: transparent; color: #f2f7fb; font: inherit; cursor: pointer; }
    .app-loading-retry:hover { background: rgba(225, 239, 250, .12); }
    @keyframes app-loading-spin { to { transform: rotate(360deg); } }
    @keyframes app-loading-dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75%, 100% { content: '...'; } }
    @keyframes app-loading-progress { 0% { transform: translateX(-120%); } 50% { transform: translateX(125%); } 100% { transform: translateX(245%); } }
  </style>
  <noscript>
    <h1>${data.initialData.siteName}</h1>
    <p>${data.description}</p>
    <p><a href="/page/privacy.html">隐私权政策</a> · <a href="/page/terms.html">服务条款</a></p>
  </noscript>
  <script>window.__INITIAL_DATA__=${raw(initialDataJson)};</script>
  <script>${raw(failureScript(data.contactEmail?.trim() ?? '').replaceAll('<', '\\u003c'))}</script>
  <script src="/${client.bundle}.nocache" defer onerror="window.__APP_LOAD_FAILED__ && window.__APP_LOAD_FAILED__()"></script>
</body>
</html>`;
};
