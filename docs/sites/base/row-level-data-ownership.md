# 数据行归属需求开发文档

- 提出日期：2026-09-01
- 状态：已实施，2026-09-01。
- 涉及范围：base 站点：owner_uid 与受管写入；波及 global、passport

本文档只覆盖 `owner_uid` 的**字段与写入逻辑**。基于归属的可见性判定、租户维度 `owner_tid` 与代用户操作拆分为后续需求，见 [data-visibility-and-delegated-access](data-visibility-and-delegated-access.md)。

## 1. 背景

当前项目的授权只存在于页面与路由层：`roles` 用于导航项（`server/routes/base/navigation.mts:17`）、页面准入（`server/modules/base/page-context.mts:98`）和接口准入（`server/routes/base/api/panel.mts:5`）。数据层原本没有任何行级归属概念，后台管理接口一律无条件读取整表（例如 `server/routes/base/api/panel/admin/base/users.mts:36`）。结果是系统只能回答"能不能进这扇门"，无法回答"进门之后能看到哪几行"。

公共数据层已经具备"自动追加谓词"的成熟先例：`server/database/sql.mts` 的 `select`/`count` 默认只返回 `deleted_at = 0` 的记录，业务代码不感知。行级归属沿用同一个位置和同一种做法。

2026-08-31 曾按 POSIX 模型设计（`owner_uid` + `owner_gid` + `perm_mode` 三字段、容器表、`chmod`/`chown`、umask）。2026-09-01 主人确认收缩范围：**只保留 `owner_uid`**，放弃 `owner_gid`、`perm_mode`、容器表、`chmod`/`chown` 和 umask，并把可见性判定拆为后续需求。放弃理由与代价记录在 §8。

## 2. 目标

- 每张表在六个系统字段之后固定增加 `owner_uid`，标识该行归属的账号。
- 归属由公共数据层在 INSERT 时统一填充，业务代码不需要逐处处理。
- 归属来源是当前请求的登录账号，与审计用的 `device_user_id` 分开维护。
- 系统流程、迁移和登录前的写入一律留 `NULL`，作为"系统所有"的标记。
- 不改变任何既有查询的返回行集：本需求只写不读。

## 3. 命名约定

字段名定为 `owner_uid`，名称不可更改：`AGENTS.md` 已将其作为业务归属字段的标准示例，并要求它与审计来源字段 `created_duid`/`updated_duid` 分开维护。

文档中的"用户"一律指网站终端用户；`owner_uid` 指向本库用户表的账号。

## 4. 数据结构变更

### 4.1 `owner_uid`

位置固定为第 7 位，紧跟 AGENTS.md 规定的六个系统字段之后：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `owner_uid` | `BigInt?` | 由公共层在 INSERT 时写入 | 本库用户表的账号 id；`NULL` 表示系统所有 |

```prisma
model base_users {
  id            BigInt @id @default(autoincrement())
  created_at    BigInt
  updated_at    BigInt
  deleted_at    BigInt @default(0)
  created_duid  BigInt?
  updated_duid  BigInt?
  owner_uid     BigInt?
  // 业务字段
}
```

落地范围：四个 Prisma schema 共 58 个模型全部覆盖（base 10、global 11、passport 32、pve 5），`migrations/` 下四个迁移组 × sqlite/mysql/postgresql/d1 四种方言同步补齐。基础设施表 `global_schema_migrations` 由两处建表语句分别补上：`server/database/migrate.mts:16` 与 `scripts/schema-repair.mjs:17`。

每个数据库有自己的用户，各库各管各的表：`owner_uid` 只在本库内有意义，不做跨库 ID 对齐，也不与 `passport_user_id` 混用。

### 4.2 受管范围

全部数据表，无白名单。绕过不通过白名单实现，而是通过"是否绑定了归属用户"实现，见 §5.6。

## 5. 归属写入逻辑

### 5.1 归属来源

归属是**当前请求的登录账号 id**，不是审计用的 `device_user_id`。二者在 `server/worker.mts` 分别取得：

```ts
const baseUserId = currentUser?.id ?? null;        // worker.mts:146
const passportUserId = passportUser?.id ?? null;   // worker.mts:147
```

公共层不会退化到用行内的 `user_id` 之类字段推断归属：系统流程和未登录创建一律保持 `NULL`（`server/database/sql.mts:47-49` 的注释已固化该约定）。

### 5.2 传递方式

复用现有的 `withDatabaseActors`，而不是新增一套绑定函数：

- `DatabaseAdapter` 增加 `ownerUid` 与 `ownerUidForTable`（`server/database/index.mts:34,36`），与审计用的 `actorUid`/`actorUidForTable` 并列。
- `DatabaseActors` 增加 `baseUserId` 与 `passportUserId`（`server/database/index.mts:56-57`）。
- `ownerUidForTable` 按表名前缀选取（`server/database/index.mts:79-82`）：`passport_*` 表用 `passportUserId`，其余用 `baseUserId`；未显式提供时继承上游适配器。这与审计 actor 的前缀判断是同一套规则。
- 事务内递归传递，与 actors 的处理一致。

`SqlBuilder` 增加第四个构造参数 `ownerContext` 与 `ownerUidFor(table)`（`server/database/sql.mts:41,46`），三个方言子类同步透传；`sql()` 工厂按 `ownerUidForTable → ownerUid → 适配器上的同名字段` 的顺序解析（`server/database/sql.mts:235-236`）。

### 5.3 绑定策略

`server/worker.mts:152-165` 按数据库是否分库分三种情况绑定：

| 适配器 | 绑定的归属用户 | 条件 |
| --- | --- | --- |
| `scopedDatabase` | `baseUserId`；同库时另加 `passportUserId` | Passport 与 Base 同库时两者都绑，分库时只绑 Base |
| `scopedPassportDatabase` | `passportUserId` | 仅在 Passport 分库时单独创建 |
| `scopedGlobalDatabase` | `globalUserId` | 仅在 Global 分库时单独创建；该值需在默认库中另查一次 `loadCurrentUser`（`server/worker.mts:162`），因为账号 id 在不同库之间不通用 |

### 5.4 写入时机

**只有 `insert` 写 `owner_uid`**（`server/database/sql.mts:103-104`）：

```ts
const timestamped: Values = {
  created_at: timestamp, updated_at: timestamp,
  ...(actorUid !== null ? { created_duid: actorUid, updated_duid: actorUid } : {}),
  owner_uid: ownerUid,
  ...values,
};
```

由此确定的行为，全部是有意为之：

- `owner_uid` **无条件**出现在 INSERT 列名中，即使为 `null` 也显式写入 `NULL`；这与 `created_duid`/`updated_duid` 的"非 `null` 才加入"不同。因此**所有表都必须已有该列**，否则 INSERT 直接失败——这是 §4.1 要求 58 个模型无一遗漏的原因。
- `update`、`softDelete`、`restore` 不触碰归属：`updateManaged` 只自动维护 `updated_at` 与 `updated_duid`，记录的归属不随更新改变。
- `upsert` 在冲突分支不改归属：`managedUpdateKeys` 只包含调用方给的 `updateKeys` 加 `updated_at`、`updated_duid`。
- `insertExisting`、`ignoreInsertExisting` 不经过 `insert`，原样写入源库的 `owner_uid`，迁移与整库搬迁因此保留归属。

### 5.5 `owner_uid` 的可写性与过户

**`owner_uid` 是带默认值的可写字段，不是只读字段。** 它没有加入 `SYSTEM_FIELD_NAMES`，`assertBusinessWriteFields` 不拦截它；`insert` 中 `...values` 排在 `owner_uid` 之后，业务传入的值会覆盖公共层填充的值。

但**业务层不需要、也不应该关心写什么值**：公共层填的就是当前请求的 `base_user_id`，正是归属应有的值。业务代码在 `values` 里出现 `owner_uid` 只有两种可能——写了个一样的值（多余），或写了别的账号（多半是错的）。因此这是"约定不写"，不是"写不了"。

这是主人确认的设计，不是遗漏：AGENTS.md 已写明"`owner_uid` 不属于审计系统字段……后续允许通过业务过户操作修改"，`scripts/test-sql-builder.mjs` 也有对应断言 `assert.doesNotThrow(() => ownerSql.update('users', { owner_uid: '24' }, { id: 1 }))`。过户能力因此不需要新增公共层 API，直接由业务操作写字段即可。

过户涉及两个方向，风险来源不同，必须分开处理。

**方向一：把不属于自己的行改成自己所有。** 这一点不由 `owner_uid` 的可写性决定，而由是否存在写谓词决定：

- 现状：公共层没有任何写判定，理论上任何能到达 `update` 的路径都能改任意行的 `owner_uid`。但目前 `server/` 下没有任何路由把 `owner_uid` 放进可写字段清单，实际暴露面为零。通用后台 CRUD 只写 `config.writable` 列出的字段（`server/modules/pve/admin-crud.mts:38`），用户表单提交的 `owner_uid` 不会被透传。
- [data-visibility-and-delegated-access](data-visibility-and-delegated-access.md) 落地后：`update` 会带上归属谓词，能改的行本就是有权改的行，在这些行上改 `owner_uid` 与改其他任何业务字段没有区别，该方向的问题自然消失。

**方向二：把自己的行让给别人。** 单看数据可见性，这属于自愿分享，不是泄露。但只要出现任何**按 `owner_uid` 计的限额**，它就变成配额规避手段：

> 套餐限制某账号最多保留 5 条记录。账号 A 建满 5 条后把其中 3 条过户给账号 B，自己的计数降到 2，于是可以再建 3 条。若接收方 B 一侧不做配额校验，B 会被塞到 8 条，而 A、B 合计持有的记录数超出两个套餐之和。

这正是 POSIX 把 `chown` 收归 root 的原因之一——内核无法在一次普通的属主变更里原子地重算接收方配额。同类问题适用于一切按属主计的限额：条数套餐、计费用量、速率限制。

因此本需求确立一条**长期约束**，不随可见性判定落地而失效：

> 过户必须是显式的业务操作，不能作为普通 CRUD 表单字段暴露。该操作要把过户当成"转出方与接收方计数同时变化"的事件处理：按与 INSERT 相同的规则校验接收方的配额，接收方超限则拒绝。

在可见性判定与显式过户操作都未落地之前，另有一条临时护栏：

> 新增的 CRUD `writable` 与各路由的可写字段清单不要包含 `owner_uid`。

补充一条与安全无关的可用性理由：表单里放一个原始账号 id 输入框，填错会把记录转给错误的账号且本人再也看不见。

### 5.6 绕过

未绑定归属用户时 `owner_uid` 写 `NULL`，这既是系统数据的标记，也是绕过机制本身。以下路径天然落入该分支：

- 鉴权自身：`server/modules/base/auth/index.mts:115` 解析当前登录账号时需要读 `base_sessions` join `base_users`，那一刻归属尚未确定，用的是未绑定的适配器。
- 登录、注册、OIDC 回调等在会话建立之前发生的写入。
- `server/database/migrate.mts` 的迁移与种子写入。
- 未绑定适配器的系统任务、机器人与事件消费者。

## 6. 实施记录（2026-09-01 完成）

1. 四个 Prisma schema 的 58 个模型增加 `owner_uid`。
2. `migrations/` 下四个迁移组 × 四种方言补充迁移文件。
3. `server/database/migrate.mts:16`、`scripts/schema-repair.mjs:17` 的 `global_schema_migrations` 建表语句补齐 `owner_uid`。
4. `server/database/index.mts` 扩展 `DatabaseAdapter` 与 `DatabaseActors`，`withDatabaseActors` 增加 `ownerUidForTable`。
5. `server/database/sql.mts` 增加 `ownerContext`/`ownerUidFor`，`insert` 自动填充。
6. `server/worker.mts` 在既有 actors 绑定处一并绑定归属用户。
7. `AGENTS.md`、`docs/project/architecture.md` 更新字段顺序与归属字段约定。
8. `scripts/test-sql-builder.mjs` 覆盖归属填充与 `owner_uid` 可更新。

此阶段没有任何查询行为变化：所有既有查询返回的行集与实施前一致。

## 7. 影响面清单

| 位置 | 改动 |
| --- | --- |
| `prisma/{base,global,passport,pve}.prisma` | 58 个模型加 `owner_uid` |
| `migrations/**` | 四个迁移组 × 四种方言 |
| `server/database/index.mts` | `ownerUid`/`ownerUidForTable`、`baseUserId`/`passportUserId` |
| `server/database/sql.mts` | `ownerContext`、`ownerUidFor`、`insert` 填充 |
| `server/database/migrate.mts` | `ensureMigrationTable` 补 `owner_uid` |
| `scripts/schema-repair.mjs` | 同上 |
| `server/worker.mts` | 绑定归属用户 |
| `AGENTS.md`、`docs/project/architecture.md` | 字段顺序与归属字段约定 |
| `scripts/test-sql-builder.mjs` | 归属填充断言 |

## 8. 验收标准

- `npm run typecheck`、`npm run build:worker`、`npm run smoke:multi-site`、`npm run test:sql-builder` 通过。
- 全新初始化的数据库中，每张表都存在 `owner_uid` 列。
- 登录账号新增的记录，`owner_uid` 等于该账号在本库的 id。
- 迁移、种子、登录前流程写入的记录，`owner_uid` 为 `NULL`。
- 更新既有记录不改变其 `owner_uid`。
- 既有查询返回的行集与实施前完全一致。

## 9. 已知限制

- **`owner_uid` 是带默认值的可写字段，不是受保护的只读字段**：为了给过户留口子，它没有进 `SYSTEM_FIELD_NAMES`，业务层按约定不写它。把他人的行改为自己所有由写谓词约束，可见性判定落地后自然解决；把自己的行让给别人则会绕过按属主计的配额，必须由显式过户操作校验接收方，属于长期约束。见 §5.5。
- **配额与归属耦合**：任何按 `owner_uid` 计的限额（套餐条数、计费用量、速率限制）都不能只在 INSERT 处校验，过户同样会改变双方计数。本需求不提供该校验，只确立约束。
- **归属只是标记，尚不产生任何约束**：本需求只写不读，`owner_uid` 目前不影响任何查询结果。约束能力由 [data-visibility-and-delegated-access](data-visibility-and-delegated-access.md) 提供。
- **`NULL` 归属在判定上线后对普通账号一律不可见**（只有系统上下文与 `admin` 可读）。因此登录流程中创建的记录必须显式绑定归属上下文，否则记录的主人自己也看不到自己的数据，见可见性文档 §5.2。
- **归属不跨库**：账号 id 在不同库之间不通用，因此分库部署时 Global 库需要另查一次账号（`server/worker.mts:162`）。跨库比较 `owner_uid` 没有意义。
- **放弃 POSIX 三字段**：`owner_gid`、`perm_mode` 不再引入。代价是账号无法自行设置某条记录的可见性（原 `chmod`）。
- **放弃容器表**：新增记录不做行级判定，准入完全由路由层 `roles` 控制。
