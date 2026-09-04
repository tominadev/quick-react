# 本站账号与 Accounts 身份并存需求开发文档

状态：设计已确认，实施中。

前置需求：[Accounts 用户名/密码补全、登录页与账户中心](accounts-account-center.md)、[Passport 身份中心](passport-and-telegram-integration.md)。

## 1. 背景

接入 Accounts 之后，本站账号目前是**被架空**的：

- `resolveAccountsLoginMode` 只有 `'oidc' | 'local'` 两种，开了 OIDC 就把本地登录入口整个藏起来（`page-context.mts`）。
- 导航里写着「个人中心只做当前登录身份的只读展示，**账号资料由 Accounts 维护**」，因此本站用户改不了自己的用户名和密码。
- OIDC 回调建号时用占位用户名，再按 `preferred_username` 改写；**撞上已有的本站账号就直接失败**：

  ```ts
  if (user.password !== '!oidc') throw new Error('本站已存在同名用户，无法绑定 Accounts 身份');
  ```

  改名那一支更安静——`syncLocalUsername` 发现名字被占用就 `return`，用户看到的是「我在 Accounts 改了用户名，本站没变」，没有任何提示。

这套设计在「Accounts 是唯一入口」的前提下是自洽的。但只要承认**本站账号也能独立登录**，四件事就一起要做：开关、自助改资料、撞名时的绑定、以及两边密码的一致性。

## 2. 目标

- 接入 Accounts 之后，仍可**按站点配置**保留本站用户名密码登录。
- 本站用户能自己改**用户名、昵称、密码**。
- Accounts 登录时用户名撞上已有本站账号，能用**该账号的密码**证明所有权并完成绑定，而不是报错。
- Accounts 登录成功时，把密码**同步**到本站账号，使两边保持一致。

## 3. 登录模式：加一种「两者都可以」

`AccountsLoginMode` 从二选一扩成三种：

| 模式 | 含义 |
| --- | --- |
| `local` | 未接入 Accounts，只有本站登录 |
| `oidc` | 已接入，**只允许** Accounts 登录（今天的行为） |
| `both` | 已接入，**同时**保留本站用户名密码登录 |

由站点设置里的开关控制（`siteSettings.localLoginEnabled`，默认关闭）。关闭时行为与今天完全一致，因此这是一个纯增量的改动。

登录页在 `both` 模式下同时显示 Accounts 按钮与本站表单；`page-context.mts` 里 `!accountsLogin && …` 那条判断随之改成按模式判定。

## 4. 本站账号自助改资料

个人中心从只读改为可编辑，只允许改**自己**这一行的三个字段：

| 字段 | 规则 |
| --- | --- |
| 用户名 | 与注册同一套校验；租户内唯一，冲突返回 409 |
| 昵称 | **`base_users` 需要新增 `nickname` 列**（今天只有 `passport_users` 有） |
| 密码 | 需要**先验证当前密码**，与改用户名分开提交 |

改密码必须验旧密码：会话被盗时，能改密码就等于能永久接管账号。

这三处写入走 `/api/panel/me`，不在 `/api/panel/admin/` 下，因此**照常留痕、不走审批、不问变更理由**（见[变更审计](change-audit-and-revert.md) §11.2）——用户处置自己的数据不该排队等人批。

## 5. 撞名时用密码绑定

Accounts 登录时，若要写入的用户名已被本站账号占用：

```
Accounts 登录 → 本站用户名已存在 ─┬─ 该账号是 OIDC 占位号（password 为 '!oidc'）→ 直接绑定
                                  └─ 该账号是真实本地账号 → 要求输入它的密码
                                        ├─ 正确 → 绑定，保留该账号原有的角色与数据
                                        └─ 错误 → 拒绝，不泄露该用户名是否存在于本站
```

**绑定不改变被绑账号的角色。** 否则「用 Accounts 注册一个同名账号来提权」就成立了。

**冲突状态要短期暂存**，因为绑定要等用户输入密码，跨了一次请求。复用现成的机制：`base_oidc_login_requests` 已经是这类一次性凭据的表，加一种 `pending_bind` 状态即可，不新开表。暂存内容是「哪个 issuer/subject 想绑哪个 base 用户」，有效期与登录请求一致。

失败提示统一成「用户名或密码错误」，不区分「无此用户」与「密码错」——这一步是未登录状态下的密码校验，与登录接口同样的口径。

## 6. 密码同步

Accounts 登录成功时，把凭证同步到本站账号，使本站登录用同一个密码。

### 6.1 送的是哈希，不是明文

同步的是 `password` 这个 blob 本身（PBKDF2 哈希），不是明文。两边用的是**同一套哈希实现**——`server/modules/passport/identity.mts` 直接引入 `@server/modules/base/auth` 的 `createStoredPassword`——因此 blob 拷过去能原样验通。

标准 OIDC 流程里本站拿不到明文（用户是在 Accounts 的页面上输的），送哈希绕开了这个限制。

### 6.2 不能反过来读 passport 的表

一个被否掉的方案：让本站登录时直接查 `passport_user_credentials` 验密码。那样一份凭证两处用、不会漂移，看起来更优雅，但它**违反分层**——业务站点只允许访问自己的表和 `base_*` 表。`passportDatabase` 在请求上下文里拿得到只是同库测试环境的巧合，拆库之后就不成立了。

凭证必须**通过接口送过来**，由本站写进自己的 `base_users.password`。

### 6.3 走 ID Token 的自定义 claim

授权码换 token 是**服务端到服务端**的（`callback.mts` 直接 POST `token_endpoint`），不经过浏览器，因此可以在 ID Token 里带一个自定义 claim 把 blob 送过来。

两条硬性要求：

- **不能进 `profile`。** `callback.mts` 现在把整个 claims 写进 `base_oidc_users.profile`，而那是「数据管理」里可见的普通列。凭证 claim 必须在写 profile 之前剔掉，否则等于又泄一处。
- **只送 `hash`，`pattern` 送空串。** `pattern` 记的是密码的字符类布局（`"SUSLDLDDD"`），对爆破是极强的提示，而且它还显示在用户管理页上（`users.mts` 的 `readStoredPassword(row.password)?.pattern`）。空串匹配 `[DULS]*`，是合法值。

### 6.4 已知代价

- **单向。** 用户在本站改了密码，下次用 Accounts 登录会被同步覆盖回去。方向反过来做不到——本站没有 Accounts 的写入权限。
- **暴露面扩大。** OIDC 建的号今天存的是 `'!oidc'`，本站库里没有任何可破解的凭证；同步之后多了一份能直接破出 Accounts 密码的哈希。这是「一个密码两边都能登」的代价，不是可以顺手消掉的。

## 7. 数据结构变更

- `base_users` 新增 `nickname String @default("")`。
- `base_oidc_login_requests` 新增 `pending_bind` 状态与被绑账号 ID。
- `site-settings` 新增 `localLoginEnabled: boolean`（默认 `false`）。

## 8. 验收标准

- 开关关闭时，接入 Accounts 后本站登录入口不出现，行为与今天一致。
- 开关开启时，登录页同时提供两种入口，两条路径都能建立会话。
- 用户能改自己的用户名、昵称；改密码必须先通过当前密码校验。
- 用户改不了别人的这三个字段（越权返回 403 而不是 404 之外的其它码）。
- 用户名冲突返回 409，昵称无唯一性约束。
- Accounts 登录撞上占位号：直接绑定，无提示。
- Accounts 登录撞上真实本地账号：要求密码；正确则绑定且**角色不变**，错误则统一提示「用户名或密码错误」。
- 绑定后同一身份再次登录直接进入，不再要求密码。
- 这三类自助修改都留痕，都不进审批队列。

## 9. 待确认

两处已确认：

- **密码同步送哈希 blob，走 ID Token 的自定义 claim**（§6）。不读 `passport_*` 表。
- **昵称在 `base_users` 新增一列**。与 `passport_users.nickname` 各自独立：本站的昵称属于本站账号，不随 Accounts 变。
