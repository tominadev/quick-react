# 项目架构

## 构建和启动流程

执行 `npm run build` 后：

```text
src/index.tsx       -> public/bundle.js
server/app.mts      -> dist/server.mjs
server/templates/   -> 动态首页响应
```

构建只生成上述产物，不启动 Node 服务，也不执行数据库初始化。执行 `npm start` 后才会加载 `dist/server.mjs`；Hono 在同一个 8088 端口提供页面、静态资源和 `/api/*` 接口。开发模式使用 `npm run dev`，会在监听构建完成后自动启动 Node 服务。

## 请求流程

访问 `/` 时，后端先使用内存路由快照把 Host 解析为站点，再生成 `initialData`，由 `server/templates/base/index.mts` 通过 `window.__INITIAL_DATA__` 注入页面。数据包含 API/页面后缀、站点名称、页脚、调试标记、按用户角色过滤的导航、认证状态和页面访问状态；导航树同时定义菜单、路由路径、页面组件和页面元信息，前端递归导航树生成路由并通过组件注册表渲染。

静态文件只从 `public/` 提供，`dist/server.mjs` 不在静态目录中。

## 按域名覆盖静态站点（仅 Node 运行时）

`wwwroot/<site_key>/` 下的文件按站点优先于应用页面，例如 `wwwroot/passport/index.html` 会覆盖所有绑定到 `passport` 站点的域名首页，其余路径仍然交给应用。只接管 GET 和 HEAD，拒绝目录穿越，目录不存在时完全不生效。

这是 Node 运行时（`server/app.mts`）特有的虚拟主机能力。Worker 的静态资源绑定（`ASSETS`）只按路径匹配、不区分 Host，因此 Worker 部署下没有这一层，对应域名会回到应用自身的首页；应用首页本身也提供了完整的用途说明，两种部署都能满足外部身份源对首页的要求。

## Accounts 会话与账户中心

`passport` 站点的请求会在站点本地会话之外额外加载 Accounts 会话：存在时把 `accounts` 角色加入 `effectiveRoles`，并把身份写入 `passportUser`。账户中心导航用 `roles: ['accounts']` 控制可见性，接口在 `server/routes/passport/api/panel.mts` 统一做会话守卫。业务站点不复制账号资料，个人中心只展示只读信息并链接到 Accounts 账户中心。

Base 的 `base_session` 使用滑动过期策略：有效请求会把数据库 `expires_at` 和 Cookie 重新续期为 7 天，只有连续 7 天没有使用才失效；Passport 会话仍由 Passport 自己管理。

## 页面访问状态

`server/modules/base/page-context.mts` 在渲染文档前判断请求路径能否打开，并把结果写入 `initialData.pageStatus`：路径不存在返回 `404`，需要登录返回 `401`，角色不足返回 `403`；文档响应使用同一状态码，提示标题、说明和按钮全部由后端下发。合法路径缺少页面后缀时先 `302` 跳转到带后缀的规范地址。

前端在路由表末尾注册兜底路由 `src/components/common/StatusPage.tsx`，优先使用 `initialData.pageStatus`；前端路由跳转到未注册路径时改为请求 `/api/page-status` 获取同一份提示，避免出现空白页面。

## 后端驱动页面

普通后台页面由后端提供导航、组件标识、表格列和数据接口；前端只负责通用布局、表格和表单渲染。新增常规 CRUD 页面时，在 `server/routes/<site_key>/navigation.mts` 增加导航，并在同一站点的 `api/` 下增加接口文件，无需手工修改路由表。

公共请求和反馈层位于 `src/utils/common/`：`api.tsx` 负责请求加载状态、错误拦截和 `feedback` 展示，`feedback.ts` 负责跳转延迟计算；`src/utils/common/response-action.ts` 只执行后端下发的统一完成动作。认证切换使用 `navigate + refreshAuth`：应用重新读取 `/api/auth` 返回的认证和导航状态后，用浏览器路由更新当前页面，不重新加载 `bundle.js`；普通 `navigate` 仍按协议执行完整页面导航，`reload` 可带秒级 `delay` 以便先展示成功反馈；`src/components/common/Countdown.tsx` 提供登录和配置表单共用的倒计时组件。站点设置中的 `apiBootstrapEnabled` 默认关闭：关闭时服务端把认证和导航上下文注入 HTML，开启时只输出不含用户状态的公共页面壳，应用启动后从 `/api/auth` 读取认证、导航和页面状态，页面壳可交给 CDN 缓存。服务端响应输出统一由 `server/modules/base/api-response.mts` 负责，业务 API 不直接调用 `c.json()`。

API 使用物理目录作为分层中间件链。构建阶段扫描 `server/routes/*/api`，生成 Worker 可静态打包的站点路由和模块注册表；运行时不扫描文件系统。每一层优先使用当前站点实现，缺少时沿继承链回退到 `base`。动态 ID 作为参数传给已匹配的叶子处理文件，例如 `/api/panel/admin/data/rows/row-1` 仍由 `rows.mts` 处理。

## 服务端模块目录

`server/` 顶层只保留运行入口 `app.mts`、`worker.mts`；通用基础能力和站点能力按模块归档：

```text
server/modules/
├── base/                 # 基础认证、导航、请求上下文、配置和 API 运行能力
├── global/               # Global 站点能力（云服务、Telegram Bot 等）
└── passport/             # Passport/Accounts 账号中心能力
```

数据库适配器仍位于 `server/database/`，站点 API 路由仍位于 `server/routes/<site>/`。跨模块引用统一使用 `@server/*` 别名；同一模块目录内的紧邻文件才使用相对路径。

## 架构特征

本项目不是普通的前后端分离后台模板，而是面向站长搭建多套业务系统的多站点内核，主要特点如下。

### API 目录级熔断

API 目录本身就是分层中间件链，每一级目录都可以在进入子接口前终止请求：

```text
/api
  -> routes/<site>/api.mts
  -> api/panel.mts
  -> api/panel/admin.mts
  -> api/panel/admin/data.mts
  -> api/panel/admin/data/rows.mts
```

目录处理器可以直接返回响应，熔断后续执行；也可以调用 `next()` 继续进入下一级：

```ts
if (!c.get('effectiveRoles').includes('admin')) {
  return apiMessage(c, 403, '需要管理员权限');
}
return next();
```

因此登录校验、角色校验、模块状态检查和参数前置检查可以放在目录级完成，不需要复制到每个叶子接口。该机制还和站点覆盖、父站点回退结合：当前站点可以替换任意一级目录中间件，缺少时沿继承链继续使用基础实现。

### 多运行时数据库适配

同一套业务 API 同时支持 Node.js 的 SQLite、MySQL、PostgreSQL 和 Cloudflare Worker 的 D1。数据库访问通过统一适配器与参数化 SQL 构造器完成；Worker 只访问默认 Binding 或预声明的站点 Binding，Node 运行时才支持 `sqlite://`、`mysql://`、`postgresql://` DSN。

### 实体字段与跨表引用命名

实体表内部的业务字段只使用字段本身的名称，不重复实体前缀。例如设备表保存 UUID 业务键时字段名为 `key`，按“实体名 + 字段名”组合后的跨表名称就是 `device_key`，不可能产生 `device_device_key`；后者仅会在设备表错误地把字段命名为 `device_key` 后又重复添加实体前缀时出现，属于错误命名。关联设备记录主键时统一使用 `device_id`；Passport 设备使用 `passport_device_id`。字段名和跨表引用名不能通过机械重复前缀生成。

设备键的业务语义统一使用 `device_key`：设备表内部字段为 `key`，浏览器存储键为 `device_key`，请求头为 `X-Device-Key`。这些稳定名称不得带入当前项目或产品名称；设备键不是会话凭证，禁止改名为 `session_key`。浏览器长期保存设备键于 `localStorage.device_key`；浏览器导航和 OAuth/OIDC 回调使用会话级 HttpOnly `device_key` Cookie 携带设备键，浏览器重启后由前端从 localStorage 优先通过请求头提交，后端响应重新写入会话 Cookie。首次 HTML 导航暂时没有设备键时只读取活动会话和设备关系，不删除会话；后续 API 请求仍必须携带并校验设备键。它只用于设备键传输，不代表登录会话，登录成功后不能清除。

OAuth/OIDC 回调必须在一次服务端回调请求内完成授权码处理、设备绑定和会话建立，不得为了补充设备信息增加“回调页面再请求 API”的额外往返。第三方导航无法携带自定义请求头时，必要的设备键使用 HttpOnly `device_key` Cookie；非认证性的 fingerprint 缺失时直接跳过或初始化，不得触发补充请求。

### 站点继承与表归属分离

业务站点可以继承 `base` 或其他业务站点，只覆盖需要修改的 API、导航和页面配置。代码继承不会改变业务表归属：表由声明它的代码级站点固定拥有，子站点继承父级 API 时仍访问父级声明的表。

### 后端驱动页面

导航、页面组件、表格列、表单字段、校验规则和文案由后端返回，前端通过 `shared/types` 中的协议类型渲染通用组件。这样新增常规管理页面主要是增加后端导航和 API 配置，而不是重复编写前端页面。

### 前后端共享协议

`shared/types/` 集中保存跨运行时协议，包括 API 反馈、FormPage、表格、Dashboard、导航、初始化数据和用户身份。Node、Worker 和浏览器端共同使用这些类型，减少接口漂移和重复 DTO。

TableCRUD 的下拉字段支持通过 `dependsOn`、`parentValues` 和选项的 `parentValue` 描述本地联动，也支持通过 `remoteOptions` 声明依赖字段并从当前资源 API 延迟加载选项。远程请求在依赖变化后防抖执行，并通过 `clearFields` 清空下游旧值；选项的 `fieldValues` 可以回填同一表单中的派生值，`readOnlyWhen.optionValues` 根据来源字段已有选项统一控制派生字段锁定，空值、未知值和 `__custom__` 保持可编辑。`multiple` 和 `allowCustomValue` 分别支持多选与手工输入，`hideInTable` 允许字段只出现在抽屉。这些能力属于通用表单协议，不与云服务 API 耦合。

TableCRUD 同时支持可选的游标分页响应 `nextCursor` 和 `hasMore`。前端请求统一提交 `cursor`，后端能力模块负责把它映射到实际协议的 continuation token；没有游标字段的普通表格继续使用 `totalRecords`，两种模式不会互相污染。

### 云运行时能力

全局控制面按“凭据优先、能力独立”组织云能力。所有能力先选择凭据，Provider 由凭据推导；不建立混合不同能力的通用服务表。对象存储直接使用 `global_cloud_object_storage_buckets`、`global_cloud_object_storage_bindings` 和用途关联表，邮件、短信等能力实现时使用各自的数据模型。完整约束见 `docs/requirements/cloud-capability-management.md`。

云厂商、可用服务和内部适配器映射集中在 `server/modules/global/cloud/catalog.mts`。协议实现位于 `server/modules/global/cloud/providers/`，使用 `fetch` 和 Web Crypto，不引入厂商 SDK，也不依赖本地文件系统。当前首先实现对象存储，浏览器通过预签名 URL 直传和下载，Node 与 Cloudflare Worker 不中转大文件。

云能力按模块创建，不使用混合所有字段的通用表单。对象存储的一条资源就是一个 Bucket 接入配置：创建时先选择凭据，再读取 Bucket，并由 Bucket 元数据自动回填 Region、Endpoint 和 Path Style；不填写人工名称，也不重复选择服务或 Provider。Endpoint 属于 Bucket 配置并允许覆盖，不属于凭据。凭据 Secret 只在服务端参与签名。站点只有存在启用的 Bucket 绑定且拥有对应用途关联时，才获得该对象存储能力。

Provider 在后端代码中注册控制面 API 规则、Bucket Endpoint 推导规则、能力适配器和可选的凭据测试处理器。凭据管理统一提供测试 action：支持的 Provider 执行真实校验，不支持独立测试的 Provider 返回明确反馈。每个已配置 Bucket 始终可以使用完整连接参数执行 Bucket 测试。

### 统一反馈与动作调度

所有接口消息都放在 `feedback` 中。反馈可以描述普通消息、Inline、Modal、倒计时和后续动作；前端通过 `runAfterFeedback` 统一处理登录跳转、退出刷新和表单刷新，业务页面不再重复实现倒计时和延迟逻辑。

### 路径与运行时伪装

页面路径和 API 路径由同一套路由配置生成，并支持 `.html`、`.php` 等可配置后缀。技术栈配置还可以伪装 Server、Nginx、PHP 版本等响应特征，便于兼容性测试和隐藏实际服务实现。

### 身份、设备与分布式演进

Passport 是统一身份中心，并维护自己的 Passport 设备、`passport_device_users` 和 Accounts 会话；各业务站点维护自己的 Base 设备、`base_device_users`、`duid` 和本地会话，不直接跨库读取其他站点的业务数据。站点注销通过签名事件携带 `passport_user_id` 与设备指纹通知各站点，各站点解析并注销自己的本地会话。

PostgreSQL 是设备关系、会话和撤销状态的权威存储，依靠事务、唯一索引和外键保证一致性。Redis 等缓存只保存可重建的会话或撤销加速数据，事件总线（Redis Streams、NATS 或 Kafka）负责跨站点传播登录、注销和风险变更；CouchDB 或对象存储仅用于长期审计历史与事件归档，不作为当前会话的唯一事实来源。业务 API 通过统一数据库上下文获取 `duid`，不得在各业务表重复实现设备解析。

所有 Prisma 业务表统一包含 `deleted_at` 软删除字段，SQL 公共层的 `select` 和 `count` 默认只返回 `deleted_at = 0` 的记录。固定系统字段 `id`、`created_at`、`updated_at`、`deleted_at`、`created_duid`、`updated_duid` 由公共层统一维护，后台和用户表单只能展示，禁止业务写入。回收站查询必须显式使用 `deleted: 'deleted'`，全量迁移或审计读取使用 `deleted: 'all'`；业务代码不得通过手写条件绕过默认删除范围。

## 安全策略定位

本框架默认以最大化技术自由度为目标，而不是封闭式 SaaS。默认实现保留底层数据库、站点继承、调试、迁移和运行时适配能力；安全边界通过角色、配置和目录级 API 中间件表达，不把所有高级能力强行隐藏。

如果需要封闭式 SaaS，应明确列出需要收紧的能力，并通过新的基础继承层或覆盖实现替换默认策略，例如：

- 租户级用户和权限隔离
- 禁止跨站点管理
- 禁止查看或编辑底层认证数据
- 禁止任意数据库目标和迁移
- 限制调试接口和运行时配置
- 收紧 API 目录级熔断和数据访问规则

开放模式和封闭模式可以共存于同一套内核：业务站点选择不同的基础继承层，开放能力不需要为 SaaS 场景提前牺牲。

## 开发监听

`npm run dev` 会监听前端和后端源码。前端构建结果会立即更新；后端源码重新构建后需要重启进程才能加载新模块。
