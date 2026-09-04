# 数据可见性与代用户操作需求开发文档

状态：结构与归属写入已实施（2026-09-04）；可见性判定与代用户操作未实施。

前置需求：[数据行归属](row-level-data-ownership.md)。相关需求：[代理用户与管理视图](agent-tenants-and-management-views.md)、[变更留痕与撤回](change-audit-and-revert.md)。

## 1. 背景

授权原本只存在于页面与路由层：`roles` 用于导航项（`server/routes/base/navigation.mts`）、页面准入（`server/modules/base/page-context.mts`）和接口准入（`server/routes/base/api/panel.mts`）。系统能回答"能不能进这扇门"，不能回答"进门之后能看到哪几行"。

2026-09-04 已实施三层归属字段与主机名解析（§4），因此每一行数据现在都带有租户、分站和账号归属。**但判定尚未实现**：`select`、`count`、`update`、`delete` 仍然不看这些字段，任何通过路由角色检查的账号仍能读到整表数据。本文的其余部分定义这一层判定。

公共数据层已有"自动追加谓词"的成熟先例：`server/database/sql.mts` 的 `select`/`count` 默认只返回 `deleted_at = 0` 的记录，业务代码不感知。判定沿用同一位置和同一手法。

## 2. 三个层级

这套系统里有三个容易混淆的"隔离"概念，先钉死：

| 概念 | 隔离什么 | 存哪 | 强度 |
| --- | --- | --- | --- |
| **代码站点** | 跑哪套路由、导航、页面、API，用哪个数据库 | `global_sites`、`global_site_hosts`（控制面库） | 可到物理分库 |
| **租户** | 同一个库内的一整套业务：配置、用户名空间、数据 | `base_tenants` + `owner_tid` | 逻辑，靠唯一索引与谓词 |
| **分站** | 租户内部的一层分组：自己的域名、自己的用户与代理 | `base_branches` + `owner_bid` | 逻辑，靠谓词 |

**租户相当于开了一个全新的网站**，配置独立、用户名空间独立。**分站在租户下面**，与同租户的其他分站**共享用户名空间**，绑定自己的二级或顶级域名，价格由租户分配，全局功能受限，只管自己所属的用户和代理。

命名一律不使用 `site` 指代租户或分站——`global_sites` 已经占用该词。缩写 `tid` = `tenant_id`、`bid` = `branch_id`，与既有的 `duid` = `device_user_id` 同例，定义在 `AGENTS.md`。

## 3. 数据结构（已实施）

### 3.1 归属字段

固定排在六个系统字段之后，由粗到细：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `owner_tid` | `BigInt @default(1)` | 归属租户，指向 `base_tenants.id` |
| `owner_bid` | `BigInt @default(1)` | 归属分站，指向 `base_branches.id` |
| `owner_uid` | `BigInt?` | 归属账号，指向本库用户表；`NULL` 表示无主 |

**前两个是 `NOT NULL`，第三个可空。** 这不是随意的：`owner_tid` 参与唯一索引（§3.4），而唯一索引里的 `NULL` 互不相等，可空会让约束静默失效——实施过程中该问题一次性造成了配置写入插重复行、种子重复四条、平台账号可同名三个缺陷。`owner_bid` 保持 `NOT NULL` 则是为了让用量与计费的聚合不出现 NULL 桶。`owner_uid` 不进任何唯一索引，`NULL` 在那里是诚实且无害的。

没有请求上下文时（迁移、种子、CLI）公共层**不写**这两列，由数据库默认值落到默认租户的主分站。

三者都在**创建时定死**：账号之后调去别的租户或分站，不改变旧数据的归属。因此不需要任何回写——若改为跟随属主，一次调动就要修改该账号在全部 60 张表中的所有行，而 D1 没有事务，中途失败会留下部分表归属陈旧的状态。

### 3.2 `base_tenants` 与 `base_branches`

| 表 | 业务唯一键 | 说明 |
| --- | --- | --- |
| `base_tenants` | `(key, deleted_at)` | 租户 key 全库唯一 |
| `base_branches` | `(key, owner_tid, deleted_at)` | 分站 key **在租户内**唯一，不同租户可各有同名分站 |

分站所属的租户就是它自己的 `owner_tid`，不另设 `tenant_id`。

种子建立默认租户（`key = 'default'`）与它的主分站（`key = 'main'`）。**新建租户时必须一并建立它的主分站**，否则该租户的域名无处可绑。

### 3.3 `base_hosts` 与主机名解析

| 字段 | 说明 |
| --- | --- |
| `hostname` | `(hostname, deleted_at)` 唯一：一个域名只能指向一处 |
| `tenant_id` | 必填 |
| `branch_id` | 必填 |

**每个域名都同时绑定租户和分站**，不存在"不属于任何分站"的状态：租户自己的域名绑到它的主分站。允许无分站会在每一张用量报表和每一次计费归集里留下 NULL 分支，那正是这类缺陷的来源。

写入时必须校验：`branch_id` 指向的分站，其 `owner_tid` 等于本行的 `tenant_id`。否则会出现"域名说租户 A、分站属于租户 B"的错位。**该校验尚未实现**，见 §9。

解析分两阶段，边界是"**控制面只认站点，站点库只认租户和分站，谁都不越界**"：

1. **控制面，内存快照**（`server/modules/base/site-router.mts`）：主机名 → 站点 → `databaseTarget`。
2. **站点库，按库缓存**（`server/modules/base/tenant.mts` 的 `resolveHostScope`）：同一个主机名 → `(tenant_id, branch_id)`，一次查表拿到两个，不需要 join。

同一个主机名出现在两张表里，但回答的是两个不同的问题，不是同一事实抄两遍。因此 `global_site_hosts` 不增加任何租户或分站字段。

未登记的主机名落到默认租户的主分站，单租户单分站部署因此开箱即用。缓存 TTL 与控制面一致（30 秒），绑定或解除域名后应主动刷新。

### 3.4 租户内唯一的业务键

租户是"一整套网站"，因此这些键**在租户内唯一**，分站不参与：

| 表 | 唯一键 |
| --- | --- |
| `base_users` | `(name, owner_tid, deleted_at)` |
| `base_oidc_users` | `(issuer, subject, owner_tid, deleted_at)` |
| `base_configs` | `(key, owner_tid, deleted_at)` |
| `base_bootstrap` | `(key, owner_tid, deleted_at)` |

用户名跨分站共享正是分站与租户的关键区别。同一个 Accounts 身份在每个租户各有一个本地账号。配置与引导状态按租户独立，缺省值由代码中的 `defaultSiteSettings` 等补齐，不在库里存"平台默认行"。

**加了唯一维度就必须同步改查找**：只加索引不改查找，会出现同名多行而查询仍取第一条。登录查找尤其关键——不按租户过滤会在租户 B 的域名上验到租户 A 的同名账号。以下查找已带租户：登录、Accounts 身份映射、用户名同步、后台建用户。

其余唯一键**不加租户维度**，判断规则是：

> 唯一键是**人取的名字**（用户名、显示名、业务编号）→ 加 `owner_tid`；
> 是**系统生成的标识或安全令牌**（UUID、hash、token、幂等键）→ 不加。

给令牌类唯一键加租户是**有害**的：这些表按单键查找（`where token_hash = ?`），允许两个租户存同一个值会让查询返回多行，反而制造跨租户认证。`passport_*` 整层也不加——Passport 是跨站点跨租户的统一身份中心，租户维度体现在各站点库的 `base_oidc_users`。

### 3.5 归属写入（已实施）

公共层在 `insert` 时按当前请求填充三列，业务代码按约定不写它们。以下路径在会话建立**之前**运行，必须显式绑定归属上下文，否则写出的行无主：

- `server/modules/base/device.mts` 的 `ensureBaseDevice`（设备与设备-账号绑定）
- `server/routes/base/api/sign.mts` 的会话创建
- `server/routes/base/api/accounts/oidc/callback.mts` 的身份绑定、会话与 OIDC 会话映射

账号行归属账号自己，而不是创建它的管理员：自增 id 要插入后才知道，因此回写一次。判定上线后，用户读自己的账号记录靠的就是它。

## 4. 可见性

### 4.1 作用账号

判定的中心概念是**作用账号**：当前请求代表谁在看数据。默认等于登录账号；具备代查角色的账号可以显式指定为本分站内的另一个账号（§5）。

```ts
export type SqlSubject = {
  actingUid: bigint | null;   // 作用账号，默认等于登录账号
  actingTid: bigint;          // 当前租户，由主机名解析
  actingBid: bigint;          // 当前分站，由主机名解析
  roles: string[];
};
```

`actingTid` 与 `actingBid` 已由 §3.3 的解析提供并绑定到请求级适配器；本需求只需补 `actingUid` 与 `roles`。Base 与 Passport 是两套独立账号体系，主体也分两套，按表名前缀选取，与既有的审计与归属通道一致。

**未绑定主体时视为系统上下文，完全跳过判定。** 这条同时解决了鉴权自身的死锁：`server/modules/base/auth/index.mts` 解析登录账号时要读会话与用户表，而那一刻主体尚未确定，用的正是未绑定的适配器。迁移、种子、清理任务同理；`insertExisting`、`ignoreInsertExisting` 亦不受影响。

### 4.2 规则

按顺序判定，命中即止。读与写适用完全相同的规则。

| # | 条件 | 读 | 改 / 删 |
| --- | --- | --- | --- |
| 1 | 主体未绑定，或角色含 `platform_admin` | 全部 | 全部 |
| 2 | 角色含 `tenant_admin`，且 `owner_tid` = 当前租户 | 允许 | 允许 |
| 3 | 角色含 `branch_admin`，且 `owner_bid` = 当前分站 | 允许 | 允许 |
| 4 | `owner_uid` = 作用账号 | 允许 | 允许 |
| 5 | 其余（含 `owner_uid IS NULL`） | 拒绝 | 拒绝 |

`owner_uid` 为 `NULL` 的行是系统所有的（迁移、种子、配置），没有任何普通账号能匹配第 4 条，因此一律不可见。判定在这里 fail closed，是有意的。

### 4.3 角色

角色是集中常量，定义在 `shared/types/role.mts`，不进数据库。命名统一为 `<范围>_<职能>`：读到角色键即可判断可见范围，写角色门时不会像复用一个泛化的 `admin` 那样误放行。

| 角色 | 谓词 | 代查范围 | 谁能授予 |
| --- | --- | --- | --- |
| `platform_admin` | 不追加 | — | `platform_admin` |
| `platform_support` | `owner_uid = ?` | 任意租户内任意账号 | `platform_admin` |
| `tenant_admin` | `owner_tid = ?` | — | `platform_admin` |
| `tenant_support` | `owner_uid = ?` | 本租户内任意账号 | `platform_admin`、`tenant_admin` |
| `branch_admin` | `owner_bid = ?` | — | `platform_admin`、`tenant_admin` |
| `branch_support` | `owner_uid = ?` | 本分站内任意账号 | `tenant_admin`、`branch_admin` |
| `agent` | `owner_uid = ?` | `agent_uid` = 自己的账号 | `tenant_admin`、`branch_admin` |
| `public` / `user` / `accounts` | `user` 为 `owner_uid = ?` | — | 运行时隐式授予 |

**管理类靠谓词看整片，服务类靠代查看单个**——广度归管理，精度归服务。`tenant_admin` 与 `branch_admin` 各自覆盖一层，不需要代查；`tenant_support`、`branch_support` 与 `agent` 默认只看自己的数据，要看别人必须显式指定一个账号并留下审计记录。

三者共用同一套代查机制（作用账号传递、目标校验、审计表），**只有范围校验那一条不同**，因此不需要三套实现。

角色名不使用 `root`：Unix 里 root 是账号（uid 0）而非角色，用作角色名会误导。

界面上不会出现光秃秃的角色键：`roleLabel` 按"中文名(英文键)"渲染，显示为「分站管理员(branch_admin)」。

**分站受限的部分**由路由层角色门表达，不靠行级判定：系统设置、数据管理、租户与分站管理收窄到 `platform_admin`，基础管理对 `tenant_admin` 与 `branch_admin` 开放。

### 4.4 谓词

在 `SqlBuilder.select` 现有 `deletedConditions` 的同一位置追加，`count` 同理；`update`、`softDelete`、`restore`、`delete`、`advanceNumber` 用同一段。

| 主体 | 追加的条件 |
| --- | --- |
| 未绑定，或含 `platform_admin` | 不追加 |
| 含 `tenant_admin` | `owner_tid = ?` |
| 含 `branch_admin` | `owner_bid = ?` |
| `actingUid` 为 `NULL` | `1 = 0` |
| 其余 | `owner_uid = ?` |

**每种情况都是单个索引等值**，没有 `OR`、没有子查询、没有 JOIN。这是放弃等级模型换来的（§8）：等级模型必须回答"这一行的属主等级是多少"，而那个事实不在行上；作用账号模型只问"这一行是不是我的"，答案就在行上。

`actingUid` 为 `NULL` 时必须显式生成 `1 = 0`。SQL 里 `owner_uid = NULL` 求值为 unknown、恰好也不返回行，但那是巧合而非语义。

谓词**只作用于主表**，关联表的可见性由业务查询自身保证，理由见 §9。

现有 `SqlCondition` 只能表达 `column operator value`，承载不了 `1 = 0` 这类常量条件，需要一个仅供公共层内部构造的原始表达式变体，不对业务代码开放，以免绕开 `quoteIdentifier` 的标识符校验。

### 4.5 索引

| 表 | 索引 |
| --- | --- |
| 每张受管业务表 | `(owner_uid, deleted_at)`、`(owner_tid, deleted_at)`、`(owner_bid, deleted_at)` |

### 4.6 系统数据由系统上下文读取

规则第 5 条带来一个必须遵守的约定：**基础设施数据只能用未绑定主体的适配器读取**，不能指望行级判定放行。

现有代码已经是这个形状：`server/worker.mts` 启动期的系统配置、技术栈与站点设置走未绑定适配器。需要调整的是请求级 configStore：`get` 改走未绑定适配器，`put` 仍走绑定适配器以维护审计字段。读配置不需要归属判定，写配置需要留下操作者。

### 4.7 影响 0 行的语义

**影响 0 行统一表示"记录不存在或无权限"，不区分 403 与 404。** 区分二者需要"先查权限再写入"的事务，而 `server/database/d1.mts` 只实现了 `prepare` 与 `batch`，没有 `transaction`。该行为在安全上亦更优：不泄露记录存在性。

### 4.8 INSERT 不做判定

新增记录不做行级判定——行尚不存在，没有属主可查，也不引入容器表承载该权限。准入由现有角色机制控制。归属填充按 §3.5 不变。

## 5. 代用户操作

### 5.1 授权与校验

具备代查角色的账号可以指定目标账号，逐条校验，任一不满足即拒绝：

1. 请求者具备 `platform_support`、`tenant_support`、`branch_support` 或 `agent`。
2. 目标账号存在于当前数据库且 `status = enabled`。
3. 目标账号落在请求者的代查范围内——三种角色只有这一条不同：

   | 角色 | 范围条件 |
   | --- | --- |
   | `platform_support` | 不限，任意租户任意账号 |
   | `tenant_support` | 目标的 `owner_tid` = 请求者的 `owner_tid` |
   | `branch_support` | 目标的 `owner_bid` = 请求者的 `owner_bid` |
   | `agent` | 目标的 `agent_uid` = 请求者自己 |

4. 目标账号不具备 `platform_admin`、`tenant_admin` 或 `branch_admin` 角色，否则构成提权。

`tenant_admin` 与 `branch_admin` 已能看到本租户或本分站的全部数据，不需要代查。

代理走代查而不是在谓词里加一支，是有意的：谓词方案要么退化成子查询（索引失效），要么要把 `owner_aid` 铺满全表并在下级换代理时跨表回写。代查让代理**默认看不到下级的业务数据**，要看必须显式指定一个账号且每次留痕，出事时能查到是谁、什么时候、看了谁。

### 5.2 传递方式

**作用账号按请求传递，不粘在会话上。** 粘在会话上会让操作者忘记自己正在操作谁的数据。由公共层在绑定主体时统一解析与校验，与归属绑定同一处，保证只有一个入口。

### 5.3 写入时的审计分离

代用户写入时归属记**目标账号**及其租户与分站，`created_duid` / `updated_duid` 记**真实操作者**的 device-user。这正是 AGENTS.md 中"业务归属字段与审计来源字段分开维护"的用途，无需新增字段即可保留完整溯源。

### 5.4 账号查找接口

要指定目标账号就得先找到它，而 `base_users` 本身受判定管辖。因此账号查找必须是**显式授权的独立接口**，以系统上下文读取，按请求者的代查范围限定（同租户、同分站或 `agent_uid` = 自己），只返回选择目标所需的最小字段。

### 5.5 代查审计

写操作已由审计字段留痕，**读操作没有行级痕迹**。因此每次以他人身份发起的请求写一条 `base_delegation_events`：目标账号、请求路径、请求方法。真实操作者由公共层的 `created_duid` 自动记录，不重复保存。

## 6. 跨层聚合视图

热路径谓词一次只对应一个租户、一个分站或一个账号，做不到跨层汇总。以下场景必须走**独立的授权接口**，以系统上下文查询并显式追加范围条件，自带角色校验，**不得**通过放宽 §4.2 实现：

- `platform_admin` 的跨租户汇总（租户列表、用量对比）。
- `tenant_admin` 的跨分站汇总（本租户下各分站的用量与计费归集）。
- `agent` 的下级用户管理视图，见代理需求。

`platform_admin` 的日常管理不需要这类接口：它的谓词是"不追加条件"，从自己所在的域名就能看到全部数据。切换域名只影响新建数据归属哪个租户与分站。

## 7. 实施步骤

已完成的部分见 §3。剩余：

1. 代查能力的三种范围实现（`tenant_support` / `branch_support` / `agent`）。
2. `server/database/index.mts` 沿归属通道补 `actingUid` 与 `roles`，形成完整的 `SqlSubject`。
3. `server/worker.mts` 在既有绑定处解析并校验作用账号，一并绑定。
4. `SqlCondition` 增加原始表达式变体；`select`/`count` 与各写方法追加谓词。
5. 请求级 configStore 的 `get` 改走未绑定适配器（§4.6）。
6. `base_hosts` 的租户与分站一致性校验（§3.3）。
7. 租户与分站管理页面（`/panel/admin/base/tenants`、`/panel/admin/base/branches`，`platform_admin` 限定），含域名绑定与控制面可达性校验；新建租户时自动建主分站。
8. 代查角色的实际能力、账号查找接口、`base_delegation_events`。
9. 逐个复核 `server/routes/base/api/panel/admin/**` 下现有的全表查询。
10. 补充冒烟用例，覆盖 §10 的全部验收条目。

第 9 步风险最高：这些接口今天是无条件全表读取，谓词生效后返回的行集会变化。

## 8. 为什么放弃等级模型

2026-09-01 曾设计"用户权限等级"：账号带 0–3 级，同级互不可见，高等级自动看到低等级的数据。2026-09-04 放弃。

| 维度 | 等级模型 | 作用账号模型 |
| --- | --- | --- |
| 谓词 | `owner_uid = ? OR EXISTS (SELECT ... perm_level < ?)` | 单个索引等值 |
| 索引 | `OR` 使业务表索引失效 | 正常生效 |
| 可审计 | 静默放大，日志看不出是否看过他人数据 | 每次代查是显式动作，可记录 |
| 最小权限 | 高等级账号平时就泡在所有人数据里 | 默认只看自己，需刻意切换 |
| 新增字段 | `perm_level` | 无 |

## 9. 已知限制

- **不能表达协作**：两个平级账号无法共享数据，也无法把单条记录分享给指定的人。若出现该需求，需要在 `owner_uid` 之外增加共享关系表。
- **跨层汇总必须单开接口**：热路径谓词一次只对应一层，见 §6。
- **分站之间平级**：不支持分站再分分站。多级分销由代理关系表达，见代理需求。
- **归属创建时定死**：账号调去别的租户或分站后，其旧数据仍归属原处。这是有意的，但租户或分站合并时需要运维显式迁移。
- **`base_hosts` 一致性靠约定**：租户与分站的一致性校验尚未实现，目前只写在文档与注释里。
- **谓词只作用于主表**：关联表若含敏感数据，需要业务查询显式限制。
- **未绑定主体即放行**：绕过机制的代价，靠"绑定点唯一"和冒烟用例约束，不靠类型系统保证。

## 10. 验收标准

结构部分（已达成）：

- 每张表都存在 `owner_tid`、`owner_bid`、`owner_uid` 三列且顺序固定，前两列 `NOT NULL`。
- 全新初始化的数据库中，默认租户与其主分站各一行，`base_bootstrap` 恰好一行。
- 登录账号新增的记录，三列分别等于当前租户、当前分站与该账号；账号行归属自己。
- 迁移与种子写入的记录落到默认租户的主分站，`owner_uid` 为 `NULL`。

判定部分：

- 账号 A 新增记录后能查到、能改；同分站账号 B 查询返回 0 行，`update` 影响 0 行且不抛错。
- `branch_admin` 能查到并改动本分站任意账号的数据，查询同租户其他分站的数据返回 0 行。
- `tenant_admin` 能查到并改动本租户任意分站的数据，查询其他租户的数据返回 0 行。
- `platform_admin` 与未绑定主体能查到全部数据。
- `owner_uid` 为 `NULL` 的记录：非 `platform_admin`、非 `tenant_admin`、非 `branch_admin` 账号查询返回 0 行。
- 普通账号登录后页面正常渲染，站点配置读取不受判定影响。
- `tenant_support` 指定同分站账号后能查到并改动其数据；指定其他分站账号、其他租户账号或任一管理员账号时被拒绝。
- 不具备 `tenant_support` 的账号指定任何目标账号都被拒绝，作用账号仍是自己。
- 代用户新增记录后，归属是目标账号，`created_duid` 是操作者的 device-user。
- 每次代查请求在 `base_delegation_events` 留下一条记录。
- 不同租户可以各有同名用户；同租户内重名被拒绝。
- 不同租户可以各有同名分站 key；同租户内重名被拒绝。
- `base_hosts` 绑定分站时，若该分站属于另一个租户则被拒绝。

## 11. 待定事项

- 前置需求 §5.5 领取与过户时由业务代码直接写 `owner_uid` 的问题，见 [数据行归属](row-level-data-ownership.md) §5.5。
