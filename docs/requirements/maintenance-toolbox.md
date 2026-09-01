# 维护工具箱与救援操作需求

本文档定义统一的维护工具箱。它用于处理登录配置错误、运行状态检查和可控修复，目标是让管理员在普通后台登录失效时仍能安全恢复系统。本文档只定义需求，未完成的条目不得视为已实现。

## 1. 背景与目标

当前 `Accounts OIDC 登录` 配置错误时，管理员可能无法进入正常后台，只能直接修改数据库配置。这个过程容易误改字段、泄露密钥，也无法留下统一的操作记录。

维护工具箱需要提供：

- 正常登录后的可视化工具箱；
- 不依赖 Passport/OIDC 的受限救援入口；
- 配置查看、关闭、恢复默认和状态检查；
- 明确的确认提示、幂等操作和审计记录；
- Node SQLite、MySQL、PostgreSQL 与 Worker D1 的统一 API 协议。

这里的“关闭 Passport 功能”必须拆成明确的能力名称：

- `Accounts OIDC 登录`：业务站点通过 Passport 登录的开关；关闭后回到本站用户名密码登录；
- `Passport 外部身份源`：Google、微信等上游登录源的启用状态；
- `Passport 站点`：账号中心本身的站点能力，不因关闭 Accounts OIDC 登录而被删除或停用。

界面和反馈禁止只写“关闭 Passport”，必须显示完整能力名称和作用范围。

## 2. 入口与路径

### 2.1 正常入口

维护工具箱属于 Base 公共能力，所有继承 Base 的站点使用同一套页面、API、权限和协议：

```text
菜单：基础管理 -> 维护工具
页面：/panel/admin/base/maintenance.html
API： /api/panel/admin/base/maintenance.php
代码：server/routes/base/api/panel/admin/base/maintenance.mts
```

正常入口要求当前站点的管理员会话和 `maintenance.read` 能力。工具箱不能因为当前站点是 `passport`、`global` 或业务站点而复制一份特殊实现。

### 2.2 救援入口

正常入口因 OIDC 配置错误不可用时，允许通过独立救援页面建立短期维护会话：

```text
页面：/maintenance/
会话 API：/api/maintenance/session.php
工具 API：/api/maintenance/
```

救援入口不经过普通站点登录、Passport 登录或 OIDC 登录，但必须同时满足：

1. 运行环境显式配置 `MAINTENANCE_SECRET`；未配置时救援入口完全关闭；
2. 请求来源符合 `MAINTENANCE_ALLOW_CIDRS`，默认只允许回环地址；
3. 输入一次性维护口令，服务端只保存其哈希，不保存明文；
4. 创建短期、可撤销的 HttpOnly 维护会话；
5. 会话建立后立即从地址栏和后续请求中移除口令，不把口令作为长期 Cookie、Referer 或页面数据返回。

救援会话只拥有显式列出的维护能力，不等同于管理员会话，不能读取用户密码、云 Secret、OIDC Client Secret、任意 SQL 或服务器文件。

救援页面和 API 必须返回 `Cache-Control: no-store`，禁止 CDN 缓存；失败响应不区分“口令错误”“来源不允许”或“会话不存在”，避免泄露救援配置。

## 3. 工具箱界面

工具箱采用后端驱动的通用 `toolbox` 页面协议。后端负责下发分组、卡片、说明、按钮顺序、确认文案、禁用状态和权限；前端只渲染通用卡片并执行稳定动作 key，不按站点名称或 API 字符串自行判断。

初始分组：

### 3.1 登录与身份恢复

- 当前 Accounts OIDC 登录状态、Issuer、客户端 ID；绝不返回客户端密钥；
- 关闭 Accounts OIDC 登录；
- 启用 Accounts OIDC 登录；
- 恢复 Accounts OIDC 默认配置；
- 查看 Google、微信身份源启用状态；
- 单独停用 Google 或微信身份源。

每个动作必须显示作用范围。例如：

```text
关闭 Accounts OIDC 登录
作用：当前数据库中继承 Base 的站点回到用户名密码登录，不删除 Passport 账号和外部身份。
```

### 3.2 站点设置恢复

- 恢复站点设置默认值；
- 恢复系统配置默认值；
- 恢复技术栈伪装默认值；
- 显示“恢复后需要保存”或“已立即生效”的准确状态。

恢复默认的语义必须由后端声明。未明确声明立即保存时，只重置当前表单，用户仍需点击“保存配置”。

### 3.3 运行诊断

- 当前运行时：Node 或 Worker；
- 数据库方言和连接状态；
- 当前站点、继承链和数据库绑定；
- migration/schema 检查结果；
- API、页面和静态资源路径后缀；
- 当前维护会话及最近维护事件。

诊断默认只读，不显示 DSN 密码、云 Secret、Cookie、维护口令或完整用户数据。

### 3.4 会话与临时状态

后续阶段可加入：

- 清理已过期的 OIDC 授权状态；
- 清理已过期的外部扫码状态；
- 撤销指定维护会话；
- 标记卡住的 webhook 事件为可重试。

这些动作必须按状态和过期时间限定范围，禁止提供“清空整张表”按钮。

## 4. 动作与响应协议

页面首次请求一次 API，同时返回工具箱结构和当前状态：

```json
{
  "toolbox": {
    "groups": [],
    "actions": []
  },
  "context": {}
}
```

动作使用稳定 key，例如：

```text
disable-accounts-oidc
enable-accounts-oidc
restore-accounts-oidc-defaults
restore-site-settings
schema-check
```

动作请求统一使用 `POST /api/maintenance/?action=<key>` 或对应的后台 API 路径。后端必须再次校验维护会话、来源、能力和目标，按钮隐藏不能替代 API 鉴权。

所有结果使用统一 `feedback` 和 `next` 响应协议：

- 成功：明确说明是否立即生效；
- 失败：说明确定的原因和下一步；
- 需要刷新或跳转：由后端返回 `next`；
- 不允许前端根据 action 名称、站点类型或错误文本自行推断后续行为。

## 5. 安全和确认规则

- 救援入口默认关闭，不能通过普通请求参数临时打开；
- 维护口令只允许一次交换，短期会话必须有过期时间和主动撤销能力；
- 所有写操作使用 `POST`，禁止用 GET 修改配置；
- 关闭、启用、恢复默认、撤销会话和修复 schema 均必须确认；
- 确认文案必须指出能力名称、作用范围和是否立即生效，不使用“该配置”“该身份”等模糊代词；
- 操作必须幂等：重复关闭、重复停用、重复恢复默认不能产生重复记录或错误副作用；
- 所有数据库写入继续通过统一 SQL 助手和数据库上下文，不允许工具箱拼接 SQL；
- 工具箱不提供任意 SQL、任意文件写入、任意命令执行或直接修改密钥内容的能力；
- 返回数据、日志和审计详情必须脱敏；
- 失败尝试需要限流，且不返回可用于枚举数据库、站点或配置的细节；
- 正常维护会话和救援维护会话都必须支持“退出当前维护会话”。

## 6. 配置和数据结构

### 6.1 配置

维护工具箱本身的非敏感配置可使用 `base_configs`：

```text
maintenance-toolbox
```

救援根密钥和来源白名单只能来自运行环境 Secret/配置，不写入数据库，不进入 Prisma migration，不在后台页面回显。

### 6.2 维护会话

如需持久化救援会话，新增 `base_maintenance_sessions`。遵循所有数据表统一字段顺序：

```text
id, created_at, updated_at, deleted_at, created_duid, updated_duid,
owner_uid, token_hash, scope, source_ip, user_agent_hash,
expires_at, last_seen_at, revoked_at, status
```

`token_hash` 使用唯一约束；维护会话没有普通设备来源时，审计设备字段为 `NULL`，不得伪造 `0`。

### 6.3 操作审计

新增 `base_maintenance_events` 保存每次维护动作：

```text
id, created_at, updated_at, deleted_at, created_duid, updated_duid,
owner_uid, session_id, action, target, status, request_id,
source_ip, details, completed_at
```

`details` 只保存脱敏后的原始诊断信息。`request_id` 用于幂等和排查；重复请求不能重复执行不可逆动作。审计记录默认不可由工具箱删除，只能按统一删除规则进入回收站。

## 7. 数据一致性

以下操作必须使用批处理或事务，不能留下不可恢复的半状态：

- 一次性维护口令交换并创建维护会话；
- 撤销维护会话并写入对应审计结果；
- 消费 OIDC/扫码一次性状态并创建必要的凭证或会话；
- schema/migration 操作及其版本记录。

单纯读取、重复可执行的设备清理、过期状态清理和诊断操作可以不使用事务，但必须限制范围并支持重试。

关闭 Accounts OIDC 登录只修改统一配置项 `accounts-oidc-client.enabled`，不得删除账号、身份、会话或客户端密钥。共享数据库时 Global、Passport 和业务站点按照现有共享配置规则同时生效；数据库分离时只影响当前目标数据库。

## 8. 多运行时要求

- Node：支持默认 SQLite、配置好的 MySQL/PostgreSQL DSN；维护工具不得扫描未知文件或自动发现数据库；
- Worker：只使用 `DEFAULT_DB` 或构建期声明的 D1 Binding，救援 Secret 从 Worker Secret 读取；
- Node 与 Worker 共用 `shared/types`、动作 key 和反馈协议；
- Worker 不执行 Node 专属的进程重启、文件备份或任意 schema 改写；这些能力必须显示为不可用或由 CLI 完成；
- 所有 API 必须经过公共响应层，页面和 API 路径保持对应。

## 9. 明确不做

- 不制作绕过所有权限的“超级管理员”账号；
- 不把维护口令写入页面、数据库明文、Cookie 或日志；
- 不让救援会话直接获得普通管理员、Accounts 或 Passport 角色；
- 不让工具箱根据站点名复制 Passport、Global 或业务站点逻辑；
- 不提供任意 SQL、任意命令、任意文件浏览和任意密钥导出；
- 不把维护工具做成 CDN 可缓存的公共管理页面。

## 10. 验收标准

- OIDC 配置错误导致普通后台无法登录时，允许在来源白名单内通过救援入口进入工具箱；
- 关闭 Accounts OIDC 后，业务站点可按现有统一开关回到用户名密码登录；
- 关闭操作不删除 Passport 用户、外部身份、OIDC 客户端或会话数据；
- 恢复默认、停用外部身份源和撤销维护会话均有明确确认；
- 重复执行同一动作不会产生重复数据或错误副作用；
- 维护口令失效、来源不允许、会话过期时均无法执行写操作；
- 页面只显示脱敏配置和诊断结果；
- 审计记录包含动作、目标、结果、时间、请求 ID 和来源信息；
- Node SQLite、MySQL、PostgreSQL 以及 Worker D1 的类型检查、Worker 构建和相关协议测试通过；
- 正常站点后台、Passport、Global 与业务站点继续使用同一套 Base 工具箱协议。

## 11. 实施顺序

1. 增加维护工具箱协议类型、Base 导航和只读诊断页面。
2. 增加 `disable-accounts-oidc`、`enable-accounts-oidc` 和 `restore-accounts-oidc-defaults`，先覆盖当前紧急场景。
3. 增加 Node 本地/白名单救援会话和维护事件审计。
4. 将站点设置、系统配置、技术栈配置的恢复默认接入工具箱。
5. 增加外部身份源停用、过期状态清理和 schema 检查。
6. 增加 Worker D1 的维护 Secret、能力限制和协议测试。
7. 补齐过期会话清理、幂等重试和安全审计测试。
