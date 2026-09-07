/**
 * **antd-mobile 的样式必须显式引入。**
 *
 * 桌面版那套 antd 是 CSS-in-JS，组件自带样式；antd-mobile 的 `es` 组件只输出类名
 * （`adm-button` 之类），样式在单独的 CSS 文件里。不引的话页面是一堆裸 HTML——能点、
 * 数据也对，就是完全没有样子，而控制台里一个错都不报。
 *
 * esbuild 把它抽成与产物同名的 `bundle-antd-mobile.css`，页面壳按清单里的 `stylesheet`
 * 引用（见 shared/web-clients.mts）。
 */
import 'antd-mobile/bundle/style.css';
import ReactDOM from 'react-dom/client';
import App from './App.js';

const rootElement = document.getElementById('root');
if (rootElement) {
	rootElement.style.height = '100%';
	ReactDOM.createRoot(rootElement).render(<App />);
}
