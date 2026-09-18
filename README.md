# quick-react

一个使用 React、Ant Design、esbuild 和 Hono 的轻量级全栈项目。

前端和后端由同一个 `node esbuild.cjs` 进程构建并启动，默认监听 `8088` 端口。

## 快速开始

需要 Node.js 20 或更高版本：

```bash
npm install
node esbuild.cjs
```

开发监听模式：

```bash
npm run dev
```

开发监听并自动重启后端：

```bash
npm run dev:restart
```

类型检查：

```bash
npm run typecheck
```

浏览器访问：

```text
http://127.0.0.1:8088/
```

## 文档

- [项目架构](docs/architecture.md)
- [开发指南](docs/development.md)
- [部署指南](docs/deployment.md)
- [配置说明](docs/configuration.md)
- [安全说明](docs/security.md)
- [API 说明](docs/api.md)

## 目录结构

```text
src/                    React 前端源码
server/                 Hono 后端源码和动态 HTML 模板
server/templates/       服务端 HTML 模板
public/                 浏览器可访问的静态资源
dist/                   后端构建产物
esbuild.cjs             前后端构建和启动入口
```

`public/bundle.js`、`public/bundle.js.map` 和 `dist/server.mjs` 都是构建生成文件，不提交到 Git。

## 免责声明

本项目以 **0BSD** 授权（见 [LICENSE](LICENSE)）：拿去随便用，不必署名、不必保留版权声明。它是一个通用的多租户管理后台脚手架，按 "按原样" 提供，不附带任何担保。

其中的 SMS 模块是一个自助式短信转发工具：手机侧的短信转发能力依赖设备持有人自愿在自己的手机上安装并授权运行 iOS 快捷指令，平台本身不持有、不出租、不代收任何手机号码的短信，也不提供绕过短信验证或批量注册相关的能力。

使用者在部署和使用本项目（包括但不限于账号认证、SMS 转发、云资源管理等模块）时，应自行确保符合所在地法律法规，特别是个人信息保护、电信管理相关的规定；因使用不当造成的任何法律后果由使用者自行承担，与本项目的作者和贡献者无关。
