# 数据可见性与代用户操作需求开发文档

状态：设计已确认，未实施（2026-09-04 主人确认）。

前置需求：[数据行归属](row-level-data-ownership.md)。该需求已于 2026-09-01 实施，为每张表提供了 `owner_uid` 归属字段和公共层的归属填充逻辑。本需求在其之上增加**租户维度、可见性判定与代用户操作**。

## 1. 背景

`owner_uid` 已经落到全部 58 张表上，公共数据层在 INSERT 时按当前登录账号自动填充。但它目前只是标记：`select`、`count`、`update`、`delete` 都不看这个字段，任何通过路由角色检查的账号仍然能读到和改动整表数据。授权因此仍停留在页面与路由层。

2026-09-01 曾设计"用户权限等级"模型：账号带 0–3 级，同级互不可见，高等级自动看到低等级的数据。2026-09-04 主人确认**放弃该模型**，改为**显式代用户操作**：谁都只看自己的数据，需要看别人时由授权角色显式指定目标账号。放弃理由与对比见 §9。

同时补入一个此前遗漏的维度：业务站点内部存在**租户**，每个租户有自己的客服，租户之间数据隔离。租户不是 `global_sites` 的代码站点，两者不可混淆。

## 2. 目标

- 每张表增加 `owner_tid`，标识该行归属的租户。
- 账号只能看到和改动归属于自己的数据。
- 授权角色可以显式指定一个目标账号，代其查看和操作，**限本租户内**。
- 代用户操作全程可审计：数据归属记目标账号，审计字段记真实操作者。
- 判定由公共数据层以谓词下推方式自动生效，业务代码不感知。
- 不引入账号等级，不新增 `perm_level`。

## 3. 命名约定

- 租户实体表为 `base_tenants`，归属字段为 `owner_tid`，普通跨表引用为 `tenant_id`。这与既有的 `owner_uid`（归属）/ `base_user_id`（跨表引用）是同一个模式。
- **不使用 `site` 一词**：`global_sites` 已经表示代码站点，再用 `site_id` 表示租户会造成歧义。
- **不使用 `sid`**：`base_oidc_sessions.sid` 已被 OIDC 协议占用（`prisma/base.prisma:116`，见 `server/routes/base/api/accounts/oidc/backchannel-logout.mts:15`），该名称由规范决定，不可更改。
- `bid` 需要在 AGENTS.md 中显式定义为 `tenant_id`，与既有的"`duid` 明确定义为 `device_user_id`"同例。
- 不使用 `branch`：分支机构隐含"同一母体的分支"，而租户之间是互相独立的主体，互不可见正是预期行为而非妥协。

## 4. 数据结构变更

### 4.1 `owner_tid`

位置固定为第 7 位，**排在 `owner_uid` 之前**：归属由粗到细，先租户后账号。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `owner_tid` | `BigInt?` | 由公共层在 INSERT 时写入 | 归属租户，指向当前数据库的 `base_tenants.id`；`NULL` 表示不属于任何租户 |

```prisma
model base_users {
  id           BigInt @id @default(autoincrement())
  created_at   BigInt
  updated_at   BigInt
  deleted_at   BigInt @default(0)
  created_duid BigInt?
  updated_duid BigInt?
  owner_tid    BigInt?
  owner_uid    BigInt?
  // 业务字段
}
```

第 1–6 位是系统字段，在 `SYSTEM_FIELD_NAMES` 中，`assertBusinessWriteFields` 直接拒绝业务传入。第 7–8 位是归属字段，**不在** `SYSTEM_FIELD_NAMES` 中：公共层填的就是正确值，业务传入会覆盖，因此是"约定不写"而非"写不了"，与前置需求 §5.5 的口径一致。

`owner_uid` 已落在现有 58 个模型的第 7 位，本次在它前面插入一列。数据库整体重建，声明顺序即实际顺序，不需要兼容既有物理布局——与 AGENTS.md "按当前数据结构直接收敛实现，默认不兼容旧版本" 一致。

**写入语义：创建时定死。** 数据属于创建它时所在的租户；账号之后调去别的租户，不改变旧数据的归属。因此不需要任何回写——若改为"跟随属主当前租户"，账号换租户就要修改它在全部 58 张表中的所有行，而 D1 没有事务，中途失败会留下部分表归属陈旧的状态，把一个组织问题换成了正确性问题。

### 4.2 `base_tenants`

| 字段 | 说明 |
| --- | --- |
| `key` | 租户标识，`(key, deleted_at)` 唯一 |
| `name` | 显示名称 |
| `status` | `enabled` / `disabled`；停用后其账号不能登录，数据保留 |

租户记录本身属于平台，`owner_uid` 与 `owner_tid` 均为 `NULL`，因此按 §5.2 对普通账号不可见，由 `super` 在后台管理。

### 4.3 `base_tenant_hosts`

主机名到租户的映射，存在**站点库**里。

| 字段 | 说明 |
| --- | --- |
| `hostname` | 主机名，`(hostname, deleted_at)` 唯一 |
| `tenant_id` | 指向 `base_tenants.id` |
| `status` | `enabled` / `disabled` |

### 4.4 主机名的两阶段解析

边界规则一句话：**global 只认站点，站点库只认租户，谁都不越界。**

| 问题 | 谁回答 | 存哪 |
| --- | --- | --- |
| 这个请求用哪套代码、哪个库 | 控制面 | `global_site_hosts` |
| 这个请求属于哪个租户 | 站点自己 | `base_tenant_hosts` |

同一个主机名会在两张表里出现，但回答的是两个不同的问题，不是同一事实抄两遍。**`global_site_hosts` 不增加任何租户字段。**

解析分两阶段：

1. **控制面，内存快照**（`server/modules/base/site-router.mts:134-153`）：`exactHosts` 精确匹配 → `wildcardHosts` 后缀匹配 → `defaultSiteKey` 兜底 → 定出站点与 `databaseTarget`。现有逻辑完全不动。
2. **站点库**：用同一个主机名查 `base_tenant_hosts` 得到 `tenant_id`。数据库此时已经选定，所以这一步不参与站点解析，不违反"主机名解析必须先于开库"这条约束。

#### 未匹配到租户时的处理

控制面有两条兜底路径——通配符与 `defaultSiteKey`——意味着**未登记的主机名照样能到达站点**。任何人把域名 CNAME 过来，或访问 `anything.sms.example.com`，都会进入站点而查不到租户。若一律按"无租户"放行，就能在上面注册出 `owner_tid` 为 `NULL` 的账号。因此按控制面的命中方式区分：

| 控制面命中方式 | 站点库无租户匹配时 |
| --- | --- |
| `exactHosts` 精确行 | 允许，视为平台自有入口（主域名），`owner_tid` 为 `NULL` |
| 通配符或 `defaultSiteKey` 兜底 | **拒绝，返回 404** |

精确行是运维显式登记的，意图明确；通配符与默认兜底只是"顺便接住"，不应被当作合法的平台入口。这样无租户账号只可能产生在管理员明确开放的主域名上。

#### 写入顺序

跨库写入没有事务，顺序是强制的：

- **新增绑定：先站点库，后控制面。** 中断只留下"租户域名已登记但路由不通"，无害可重试。反序会留下"域名能路由过来但站点库不认识它"，访客落入未绑定状态。
- **解除绑定：先控制面，后站点库。** 中断只留下"域名不通但记录还在"。

两个方向的中间态都落在无害的一侧，与 SMS 需求中的收敛写入是同一原则。

#### 三种场景的写入量

| 场景 | 控制面 | 站点库 |
| --- | --- | --- |
| 站点初始化 | 一行通配符 `*.<站点主域> → <站点>` | — |
| 新增租户 | **不动**，通配符已覆盖 | `base_tenants` + `base_tenant_hosts` 默认子域行 |
| 绑定自定义域名 | 精确行 | `base_tenant_hosts` 一行 |

新增租户时自动写入一行 `<租户 key>.<站点主域>` 的默认子域，使解析只有**一套规则**（查表），不存在"查不到再按子域标签推断"的第二套规则。运维只有绑定自定义域名时才需要两边都写，而那是解析顺序决定的物理必需。

#### 缓存

项目原则是"hosts 整表加载到内存，普通请求不查询数据库"。`base_tenant_hosts` 同样需要快照，**按数据库分别缓存**，TTL 与 `server/modules/base/site-router.mts:100` 一致（30 秒），并提供显式 `refresh()`。绑定或解除后必须主动刷新，否则运维会以为操作没生效。

这是选择 `base_tenant_hosts` 而非在控制面加租户字段所付出的主要代价：多一层按库的缓存。换来的是控制面不需要知道租户的存在。

#### 孤儿行

`base_tenant_hosts` 中的主机名若在控制面既无精确行、也不被通配符覆盖，该记录永远不会被命中，是条死数据。管理页绑定自定义域名时必须**先校验控制面可达**，不可达则提示，不得静默写入。

### 4.5 账号的租户归属

**一个账号只属于一个租户，一对一。** 不新增关联表，也不在 `base_users` 上新增 `tenant_id`——`base_users.owner_tid` 本身就是该账号所属的租户。

该值在会话解析时顺带取出：`server/modules/base/auth/index.mts:115` 已经 join 了 `base_users` 并取 `u.id`、`u.name`、`u.roles`，把 `u.owner_tid` 一起 select 出来即可，不增加查询。

**本需求不新增任何账号字段。** 等级模型放弃后，`perm_level` 不再需要。

账号所属租户在注册时由 §4.4 的第二阶段解析确定：从当前主机名查到 `tenant_id`，写入新账号的 `owner_tid`。管理员在后台建账号时则取管理员自己的租户。

## 5. 可见性

### 5.1 作用账号

判定的中心概念是**作用账号**（acting account）：当前请求代表谁在看数据。

- 默认等于登录账号。
- 具备代查角色的账号可以显式指定为**本租户内的**另一个账号，见 §6。

```ts
export type SqlSubject = {
  actingUid: bigint | null;   // 作用账号，默认等于登录账号
  actingBid: bigint | null;   // 作用账号所属租户
  superAdmin: boolean;        // roles 含 super：平台管理员，跨租户，不受判定约束
  tenantAdmin: boolean;       // roles 含 admin：租户管理员，本租户全部
};
```

Base 与 Passport 是两套独立账号体系，主体也分两套，按表名前缀选取，与前置需求 §5.2 的做法一致。绑定点仍是 `server/worker.mts:152-165`，与归属用户绑定同一处。

**未绑定主体时视为系统上下文，完全跳过判定。** 这条与前置需求的归属填充是同一个分支，因此鉴权自身天然安全：`server/modules/base/auth/index.mts:115` 解析登录账号时用的就是未绑定的适配器。

### 5.2 规则

按顺序判定，命中即止。读与写适用完全相同的规则。

| # | 条件 | 读 | 改 / 删 |
| --- | --- | --- | --- |
| 1 | 主体未绑定（系统上下文），或角色含 `super` | 全部 | 全部 |
| 2 | 角色含 `admin`，且 `owner_tid` = 自己的租户 | 允许 | 允许 |
| 3 | `owner_uid` = 作用账号 | 允许 | 允许 |
| 4 | 其余（含 `owner_uid IS NULL`） | 拒绝 | 拒绝 |

`owner_uid IS NULL` 的行是系统所有的（迁移、种子、登录前写入），没有任何普通账号能匹配第 3 条，因此一律不可见。判定在这里 fail closed，是有意的。

### 5.2.1 角色

角色是集中常量，定义在 `shared/types/role.mts`，不进数据库。本需求新增 `super` 与 `support`，并把 `admin` 收窄为租户管理员：

| 角色 | 可分配 | 可见范围 | 谁能授予 |
| --- | --- | --- | --- |
| `super` | 是 | 全部，跨租户；管理 `base_tenants` 与全部 `global_*` | `super` |
| `admin` | 是 | **本租户全部** | `super` |
| `support` | 是 | 自己的数据，加上代查本租户指定账号 | `super`、`admin` |
| `public` / `user` / `accounts` | 否（隐式） | `user` 只看自己的数据 | 运行时隐式授予 |

角色名不使用 `root`：Unix 里 root 是账号（uid 0）而非角色，用作角色名会误导。

`admin` 与 `support` 的区别是**广度与精度**：前者一次看到本租户全部数据，那是管理职责；后者一次只能指定一个账号且留审计记录，因此看不到全租户的横截面。

界面上不会出现光秃秃的角色键：`roleLabel`（`shared/types/role.mts:24-27`）按"中文名(英文键)"渲染，显示为「平台管理员(super)」「租户管理员(admin)」，范围一眼可见；`description` 中同样写明"仅限本租户"。

#### `admin` 语义变窄带来的两处强制改动

`admin` 从"平台管理员"变成"租户管理员"，是一次**静默的权限收窄**——既有代码不会报错，但边界移动了。以下两处必须一并处理，否则会留下真实缺陷：

**一、既有 `roles: ['admin']` 门要逐个改判。** 平台级入口改为 `roles: ['super']`，租户级入口保留 `admin` 或写成 `['super', 'admin']`。至少涉及 `server/routes/base/navigation.mts:17,25`、`server/routes/global/navigation.mts:17`。判断标准：控制面（`/panel/admin/global/*`）、租户管理页、数据库与站点管理归 `super`；本租户的账号与业务管理归 `admin`。

**二、救援入口必须改为授予 `super`。** `server/modules/base/maintenance/actions.mts:43` 目前恢复 `base_users.id = 1` 时写入 `admin`。该账号建立时没有会话，`owner_tid` 为 `NULL`，而收窄后 `admin` 的谓词是 `owner_tid = ?`——`owner_tid = NULL` 求值为 unknown，一行都查不到，救出来的会是一个什么都看不见的管理员。`super` 不追加任何谓词，救援才成立。这与维护文档中既有的 `rescue_superadmin` 救援上下文语义一致，见 [维护工具箱](maintenance-toolbox.md)。同理 `server/routes/base/api/sign.mts:63` 创建的初始管理员也应为 `super`。

### 5.3 谓词

在 `SqlBuilder.select` 现有 `deletedConditions` 的同一位置追加，`count` 同理；`update`、`softDelete`、`restore`、`delete`、`advanceNumber` 用同一段。

| 主体 | 追加的条件 |
| --- | --- |
| 未绑定，或角色含 `super` | 不追加 |
| 角色含 `admin` | `owner_tid = ?` |
| `actingUid` 为 `NULL`（已绑定但无账号） | `1 = 0` |
| 其余 | `owner_uid = ?` |

**热路径永远是一个索引等值。** 没有 `OR`、没有子查询、没有 JOIN——这是放弃等级模型换来的最大收益：等级模型必须回答"这一行的属主等级是多少"，而那个事实不在行上，只能靠子查询或冗余；作用账号模型只问"这一行是不是作用账号的"，答案就在行上。

`actingUid` 为 `NULL` 时必须显式生成 `1 = 0`，不能只是省略条件。SQL 里 `owner_uid = NULL` 求值为 unknown、恰好也不返回行，但那是巧合而非语义。

**四种情况都是单个索引等值**，没有 `OR`、没有子查询、没有 JOIN。`admin` 走 `(owner_tid, deleted_at)` 索引，其余走 `(owner_uid, deleted_at)`。

对普通账号与 `support` 而言 `owner_tid` 不进谓词：作用账号的数据天然就在自己的租户里，追加租户条件是冗余的。租户条件只在 `admin` 这一支出现。

### 5.4 索引

| 表 | 索引 | 用途 |
| --- | --- | --- |
| 每张受管业务表 | `(owner_uid, deleted_at)` | 热路径等值查找 |
| 每张受管业务表 | `(owner_tid, deleted_at)` | 租户级聚合视图 |

### 5.5 系统数据由系统上下文读取

规则第 3 条带来一个必须遵守的约定：**基础设施数据只能用未绑定主体的适配器读取**，不能指望行级判定放行。

现有代码已经是这个形状：`server/worker.mts:87` 的 `createDatabaseConfigStore(database)` 用的是未绑定适配器，启动期的系统配置、技术栈与站点设置（`server/worker.mts:98-100`）都走它。只有 `server/worker.mts:166` 的 `scopedConfigStore` 是绑定的。

需要调整的只有一处：绑定版 configStore 的 `get` 改为走未绑定适配器，`put` 仍走绑定适配器以维护审计字段。读配置不需要归属判定，写配置需要留下操作者。

`base_bootstrap`、`global_sites`、`global_site_hosts` 本来就在启动期以系统上下文加载进内存，不受影响。

### 5.6 影响 0 行的语义

**影响 0 行统一表示"记录不存在或无权限"，不区分 403 与 404。** 区分二者需要"先查权限再写入"的事务，而 `server/database/d1.mts` 只实现了 `prepare` 与 `batch`，没有 `transaction`。该行为在安全上亦更优：不泄露记录存在性。

### 5.7 INSERT

新增记录不做行级判定，准入由现有角色机制控制。公共层自动写入 `owner_uid` = 作用账号、`owner_tid` = 作用账号所属租户。

## 6. 代用户操作

### 6.1 授权

由**角色**判定，不由等级判定。具备 `support` 角色的账号可以指定目标账号。`admin` 已能看到本租户全部数据，不需要代查。

**目标账号不得具备 `super` 或 `admin` 角色。** 否则 `support` 可以切换到管理员身份读写其数据，构成提权。这条必须在切换时校验。

### 6.2 目标账号的校验

切换时逐条校验，任一不满足即拒绝：

1. 请求者具备代查角色。
2. 目标账号存在于**当前数据库**且 `status = enabled`。
3. 目标账号的 `owner_tid` 等于请求者的 `owner_tid`——**限本租户**。
4. 目标账号不具备 `super` 或 `admin` 角色。

校验通过后，本请求的 `actingUid` 与 `actingBid` 取目标账号的值。

### 6.3 传递方式

**作用账号按请求传递，不粘在会话上。** 粘在会话上会让操作者忘记自己正在操作谁的数据。由公共层在绑定主体时统一解析与校验，不由各路由自行处理——与 actors 绑定同一处，保证只有一个入口。

### 6.4 写入时的审计分离

代用户写入时：

- `owner_uid`、`owner_tid` 记**目标账号**及其租户——数据是目标账号的。
- `created_duid`、`updated_duid` 记**真实操作者**的 device-user——操作是客服做的。

这正是 `AGENTS.md` 中"业务归属字段与审计来源字段分开维护"的用途，无需新增字段即可保留完整溯源。

### 6.5 账号查找接口

要指定目标账号就得先找到它，而 `base_users` 本身受行级判定管辖。因此账号查找必须是**显式授权的独立接口**，以系统上下文读取，按请求者的 `owner_tid` 限定范围，只返回选择目标所需的最小字段（id、用户名、状态）。它不依赖行级判定放行。

### 6.6 代查审计

写操作已由 `created_duid` / `updated_duid` 留痕，**读操作没有行级痕迹**。因此每次以他人身份发起的请求必须写一条审计记录：

`base_delegation_events`

| 字段 | 说明 |
| --- | --- |
| `target_uid` | 被代查的账号 |
| `request_path` | 请求路径 |
| `method` | 请求方法 |

真实操作者由公共层的 `created_duid` 自动记录，不重复保存。

## 7. 租户级聚合视图

客服需要"看本租户全部数据"时，热路径谓词（`owner_uid = 作用账号`）做不到——它一次只对应一个账号。此类视图必须是**独立的授权接口**，以系统上下文查询并显式追加 `owner_tid = <请求者租户>`，自带角色校验。`admin` 不需要它——本租户全部数据已由 §5.3 的谓词覆盖。

不得为了聚合而放宽 §5.2 的规则。

## 8. 实施步骤

1. 新建 `base_tenants` 与 `base_tenant_hosts`，四个 Prisma schema 全部 58 个模型在 `owner_uid` 之前插入 `owner_tid`，补四个迁移组 × 四种方言的迁移文件。
2. 实现 §4.4 的第二阶段解析与按库缓存，含未匹配时按控制面命中方式区分放行或 404。
3. `server/modules/base/auth/index.mts:115` 的会话查询增加 `u.owner_tid`。
4. `server/database/index.mts` 沿归属用户的通道补 `actingUid`、`actingBid` 与 `admin`，形成完整的 `SqlSubject`。
5. `server/worker.mts` 在既有绑定处解析并校验作用账号，一并绑定。
6. `SqlCondition` 增加原始表达式变体；`select`/`count` 与各写方法追加谓词。
7. 绑定版 configStore 的 `get` 改走未绑定适配器（§5.5）。
8. 新增代查角色、账号查找接口、`base_delegation_events` 与代查入口。
9. `shared/types/role.mts` 增加 `super` 与 `support`，收窄 `admin` 的语义；按 §5.2.1 逐个改判既有 `roles: ['admin']` 门，并把 `maintenance/actions.mts:43` 与 `sign.mts:63` 改为授予 `super`。
10. 租户管理页面（`/panel/admin/base/tenants`，`super` 限定），含自定义域名绑定与控制面可达性校验。
11. 逐个复核 `server/routes/base/api/panel/admin/**` 下现有的全表查询，确认管理员仍能看到应看的数据。
12. 补充冒烟用例，覆盖 §10 的全部验收条目。

第 11 步风险最高：这些接口今天是无条件全表读取，谓词生效后返回的行集会变化。

## 9. 为什么放弃等级模型

| 维度 | 等级模型 | 作用账号模型 |
| --- | --- | --- |
| 谓词 | `owner_uid = ? OR EXISTS (SELECT ... perm_level < ?)` | `owner_uid = ?` |
| 索引 | `OR` 使业务表索引失效 | 纯索引等值 |
| 可审计 | 静默放大，日志看不出是否看过他人数据 | 每次代查是显式动作，可记录 |
| 最小权限 | 高等级账号平时就泡在所有人数据里 | 默认只看自己，需刻意切换 |
| 新增字段 | `perm_level` | 无 |

等级模型必须回答"这一行的属主等级是多少"，而该事实不在行上，只能靠子查询或把等级冗余到每一行；后者在等级变更时需要跨 58 张表回写，且无事务可依。作用账号模型只问"这一行是不是作用账号的"，答案就在行上。

## 10. 验收标准

- `npm run typecheck`、`npm run build:worker`、`npm run smoke:multi-site` 通过。
- 全新初始化的数据库中，每张表都存在 `owner_tid` 列且位于 `owner_uid` 之前，`base_tenants` 存在。
- 账号 A 新增记录后，`owner_uid` 为 A、`owner_tid` 为 A 所属租户；A 能查到、能改。
- 账号 B 查询 A 的记录返回 0 行；对该记录执行 `update` 影响 0 行且不抛错。
- `owner_uid` 为 `NULL` 的记录：非 admin 账号查询返回 0 行，`update` 也影响 0 行；未绑定主体的适配器能正常读写。
- 普通账号登录后页面正常渲染，站点配置读取不受判定影响。
- 具备代查角色的客服指定同租户账号 A 后，能查到并能改动 A 的数据。
- 该客服指定**其他租户**账号时被拒绝。
- 该客服指定 `super` 或 `admin` 账号时被拒绝。
- 不具备代查角色的账号指定任何目标账号都被拒绝，作用账号仍是自己。
- 代用户新增记录后，`owner_uid` 是目标账号，`created_duid` 是客服的 device-user。
- 每次代查请求在 `base_delegation_events` 留下一条记录。
- 账号查找接口只返回请求者本租户的账号。
- 非 `super` 账号读不到 `base_tenants`。
- 在已绑定租户的主机名上注册的账号，`owner_tid` 等于该租户。
- 通配符命中但站点库无租户匹配的主机名返回 404，无法注册。
- 控制面精确登记的平台主域名可正常访问，其上注册的账号 `owner_tid` 为 `NULL`。
- 绑定自定义域名后刷新缓存，新域名立即可用；解除绑定后立即失效。
- 绑定一个控制面不可达的域名时被拒绝，站点库不产生记录。
- `admin` 能查到并改动本租户任意账号的数据，查询其他租户的数据返回 0 行。
- `admin` 进不了 `/panel/admin/global/*` 与租户管理页。
- 工具箱救援出的 `base_users.id = 1` 具备 `super`，登录后能看到全部数据。
- 并发情况下作用账号不会串：两个请求各自的作用账号互不影响。

## 11. 已知限制

- **不能表达协作**：两个平级账号无法共享数据，也无法把单条记录分享给指定的人。若出现该需求，需要在 `owner_uid` 之外增加共享关系表。
- **聚合必须单开接口**：热路径谓词一次只对应一个账号，任何跨账号统计都要走 §7 的授权接口，不能靠放宽规则实现。
- **租户是一层，没有层级**：租户之间平级，不支持"总部看所有租户"。总部场景目前只能用 `admin`。
- **`owner_tid` 创建时定死**：账号调去别的租户后，其旧数据仍归属原租户。这是有意的，但需要在租户合并或调整时由运维显式迁移。
- **谓词只作用于主表**：`select` 的关联表可见性由业务查询自身保证。
- **未绑定主体即放行**：绕过机制的代价，靠"绑定点唯一"和冒烟用例约束，不靠类型系统保证。

## 12. 待定事项

- **`sign.mts:63` 的初始管理员**。它在数据库刚建好、还没有任何租户时创建，`owner_tid` 必然为 `NULL`。按 §5.2.1 它应当授予 `super`，因此 `NULL` 租户不影响其可见范围。但若将来允许非首次的自助注册走同一路径，需要按 §4.4 补上主机名解析。
- 前置需求 §5.5 领取/过户时由业务代码直接写 `owner_uid` 的问题，见 [数据行归属](row-level-data-ownership.md) §5.5。
