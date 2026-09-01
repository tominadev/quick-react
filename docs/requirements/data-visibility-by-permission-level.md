# 用户权限等级与数据可见性需求开发文档

状态：设计已确认，未实施（2026-09-01 主人确认）

前置需求：[row-level-data-ownership](row-level-data-ownership.md)。该需求已于 2026-09-01 实施，为每张表提供了 `owner_uid` 归属字段和公共层的归属填充逻辑。本需求在其之上增加**判定**，让归属真正产生约束。

## 1. 背景

`owner_uid` 已经落到全部 58 张表上，公共数据层在 INSERT 时按当前登录账号自动填充。但它目前只是一个标记：`select`、`count`、`update`、`delete` 都不看这个字段，任何通过路由角色检查的账号仍然能读到和改动整表数据。

授权因此仍停留在页面与路由层：`roles` 用于导航项（`server/routes/base/navigation.mts:17`）、页面准入（`server/modules/base/page-context.mts:98`）和接口准入（`server/routes/base/api/panel.mts:5`）。系统能回答"能不能进这扇门"，还不能回答"进门之后能看到哪几行"。

公共数据层已经具备"自动追加谓词"的成熟先例：`server/database/sql.mts` 的 `select`/`count` 默认只返回 `deleted_at = 0` 的记录，业务代码不感知。本需求沿用同一个位置和同一种做法。

2026-08-31 曾按 POSIX 模型设计（`owner_gid` + `perm_mode`、容器表、`chmod`/`chown`、umask）。2026-09-01 主人确认改为**用户权限等级**模型：可见性由账号等级决定，不由每行的权限位决定。放弃理由与代价记录在 §8。

## 2. 目标

- 用户表增加权限等级 `perm_level`，取值 0 到 3。
- 同等级的账号之间互相看不到对方的数据。
- 等级高的账号能看到等级低的账号的数据。
- `admin` 角色能看到并改动全部数据。
- 读与写适用同一套规则：能看到就能改。
- 判定由公共数据层以谓词下推方式自动生效，业务代码不感知。

## 3. 命名约定

等级字段用 `perm_level` 而不是裸 `level`。裸名与业务语义（日志级别、菜单层级、会员等级）撞车的概率高，本项目已经出现过同类问题：`prisma/passport.prisma:266` 的 `passport_telegram_menus` 占用了 `mode`，这正是上一版设计放弃裸 `mode` 的原因。`perm_level` 在四个 Prisma schema 中均无同名字段。

文档中的"用户"一律指网站终端用户。

## 4. 数据结构变更

`perm_level` 是用户表的业务字段，不是公共层系统字段，因此不加入 `SYSTEM_FIELD_NAMES`。

| 表 | 字段 | 类型 | 默认值 |
| --- | --- | --- | --- |
| `base_users` | `perm_level` | `Int` | `0` |
| `passport_users` | `perm_level` | `Int` | `0` |

- 取值范围 0 到 3，**3 最高**，新账号默认 0。
- 范围校验在后台表单与 API 层完成（用户管理页面以固定选项下发 0–3），不依赖数据库 CHECK 约束，避免三种方言的写法差异。
- 只有 `admin` 角色可以修改 `perm_level`；普通账号在个人中心只能看到自己的等级，不能编辑。这一条必须在 `server/routes/base/api/panel/admin/base/users.mts` 的字段白名单里落实，否则等级可被自行提升。
- Base 与 Passport 是两套独立账号体系，两张用户表各自维护自己的 `perm_level`，互不影响。

## 5. 权限模型

### 5.1 权限主体

判定除了归属还需要等级与角色：

```ts
export type SqlSubject = {
  uid: bigint | null;   // 已有，即前置需求的 baseUserId / passportUserId
  permLevel: number;    // 0-3
  admin: boolean;       // roles 含 admin
};
```

`uid` 已经由前置需求提供并按表名前缀区分 Base / Passport（`server/database/index.mts:79-82`）。本需求只需沿同一条通道补充 `permLevel` 与 `admin`：`DatabaseAdapter` 扩展相应字段，`DatabaseActors` 扩展相应入参，`withDatabaseActors` 按同样的 `passport_` 前缀规则选取，事务内递归传递。绑定点仍是 `server/worker.mts:152-165`，与归属用户绑定同一处。

`admin` 由 `roles` 是否包含 `admin` 决定，取自 `server/worker.mts` 已有的 `currentUser.roles`。

### 5.2 可见性规则

按顺序判定，命中即止。读与写适用同一套规则，唯一例外是第 2 条。

| # | 条件 | 读 | 改 / 删 |
| --- | --- | --- | --- |
| 1 | 主体未绑定，或 `admin = true` | 全部 | 全部 |
| 2 | `owner_uid IS NULL`（系统所有的行） | 允许 | **拒绝**（仅 admin 可改） |
| 3 | `owner_uid` = 主体自己 | 允许 | 允许 |
| 4 | 属主的 `perm_level` < 主体的 `perm_level` | 允许 | 允许 |
| 5 | 其余（同级、更高级） | 拒绝 | 拒绝 |

第 2 条是本设计中读写规则唯一不一致的地方，属于**必要的例外**：系统种子与迁移写入的行（`base_configs`、`base_bootstrap`、`global_sites` 等）的 `owner_uid` 为 `NULL`，既不满足第 3 条也不满足第 4 条。若一并按"能看就能改"处理，任何登录账号都能改写站点配置；若连读都拒绝，`configStore`（走绑定过归属的 `scopedDatabase`，见 `server/worker.mts:166`）读不到配置，页面渲染直接失败。因此定为可读不可改。

"同级互不可见"包含 admin 之外的全部同级情形；账号始终能看到并改动自己拥有的行，与等级无关。

### 5.3 谓词

在 `SqlBuilder.select` 现有 `deletedConditions` 的同一位置追加，`count` 同理。

读谓词：

```sql
owner_uid IS NULL
OR owner_uid = ?
OR owner_uid IN (SELECT id FROM base_users WHERE perm_level < ? AND deleted_at = 0)
```

写谓词（`update`、`softDelete`、`restore`、`delete`、`advanceNumber`）去掉第一支：

```sql
owner_uid = ?
OR owner_uid IN (SELECT id FROM base_users WHERE perm_level < ? AND deleted_at = 0)
```

- 主体未绑定或 `admin = true` 时不追加任何条件。
- 子查询的用户表按目标表名前缀选取：`passport_*` 表用 `passport_users`，其余用 `base_users`，与前置需求的前缀规则一致。
- 主体 `uid` 为 `NULL` 时（已绑定但无账号，例如仅有 Accounts 身份的访客）第二支不生成。
- 用子查询而非 JOIN：`select` 的 `joins` 是业务查询自己的结构，追加 JOIN 会干扰列名和既有的 `deleted_at` 关联条件。
- 谓词**只作用于主表**，关联表的可见性由业务查询自身保证。理由见 §8。

现有 `SqlCondition` 只能表达 `column operator value`，承载不了复合表达式与子查询，需要为其增加一个原始表达式变体。该变体只允许公共层内部构造，不对业务代码开放，以免绕开 `quoteIdentifier` 的标识符校验。

### 5.4 影响 0 行的语义

**影响 0 行统一表示"记录不存在或无权限"，不区分 403 与 404。** 这是当前唯一可行方案：区分二者需要"先查权限再写入"的事务，而 `server/database/d1.mts` 只实现了 `prepare` 与 `batch`，没有 `transaction`（`sqlite.mts`、`mysql.mts`、`postgresql.mts` 三个适配器均有）。Cloudflare 部署上走不通该路径。该行为在安全上亦更优：不泄露记录存在性。

### 5.5 INSERT 不做判定

新增记录不做行级判定——行尚不存在，没有属主可查，也不引入容器表承载该权限。准入统一由现有角色机制控制（导航项的 `roles`、页面准入、接口准入）。归属写入逻辑按前置需求不变。

### 5.6 绕过

未绑定权限主体的适配器视为系统上下文，完全跳过判定。这与前置需求的归属填充是同一个分支，因此鉴权自身天然安全：`server/modules/base/auth/index.mts:115` 解析当前登录账号时需要读 `base_sessions` join `base_users`，那一刻主体尚未确定。同理适用于登录、OIDC 回调、迁移、种子和清理任务；`insertExisting`、`ignoreInsertExisting` 亦不受影响。

已知风险：忘记绑定主体等于静默放行。缓解手段是绑定点唯一（`server/worker.mts` 一处），且必须补冒烟用例覆盖"绑定主体后越权读取被拒"。

## 6. 实施步骤

1. `base_users`、`passport_users` 增加 `perm_level`，补四个迁移组 × 四种方言的迁移文件。
2. `server/database/index.mts` 沿归属用户的通道补 `permLevel` 与 `admin`，形成完整的 `SqlSubject`。
3. `server/worker.mts` 在既有绑定处一并绑定等级与角色。
4. `SqlCondition` 增加原始表达式变体。
5. `select`/`count` 追加读谓词；`update`、`softDelete`、`restore`、`delete`、`advanceNumber` 追加写谓词。
6. 用户管理页面增加 `perm_level` 字段（0–3 固定选项，仅 `admin` 可编辑）。
7. 部分撤销前置需求 §5.5 的临时护栏：写谓词生效后，"把他人的行改成自己所有"已被谓词挡住，护栏对该方向不再必要。但"把自己的行让给别人"会绕过按属主计的配额，因此 `owner_uid` 仍不得作为普通 CRUD 表单字段暴露，过户仍须走校验接收方配额的显式操作。
8. 逐个复核 `server/routes/base/api/panel/admin/**` 下现有的全表查询，确认管理员仍能看到应看的数据。
9. 补充冒烟用例，覆盖 §7 的全部验收条目。

第 8 步是风险最高的一步：这些接口今天是无条件全表读取，谓词生效后返回的行集会变化。

## 7. 验收标准

- `npm run typecheck`、`npm run build:worker`、`npm run smoke:multi-site`、`npm run test:sql-builder` 通过。
- 全新初始化的数据库中，`base_users`、`passport_users` 存在 `perm_level` 列且默认值为 `0`。
- 账号 A（`perm_level = 1`）新增记录后，A 能查到、能改。
- 账号 B（`perm_level = 1`）查询 A 的记录返回 0 行；对该记录执行 `update` 影响 0 行且不抛错。
- 账号 C（`perm_level = 2`）能查到并能改 A 与 B 的记录。
- 账号 A 查询 C 的记录返回 0 行。
- `admin` 角色能查到并能改上述全部记录。
- 未绑定主体的适配器能查到全部记录。
- `owner_uid` 为 `NULL` 的记录：非 admin 账号能读，`update` 影响 0 行。
- 非 admin 账号提交 `perm_level` 时被拒绝，自身等级不变。
- 账号 A 把自己的记录过户给账号 B 后，A 查不到该记录，B 能查到；该过户只能由显式过户操作发起，普通 CRUD 表单提交 `owner_uid` 不生效。
- 账号 A 对无权改动的记录提交 `owner_uid` 时影响 0 行，归属不变。
- 登录、OIDC 回调、退出登录、站点配置读取流程不受影响。

## 8. 已知限制

- **只能表达层级，不能表达协作**：同级互不可见意味着两个平级账号无法共享任何数据，也无法把单条记录分享给指定的人。若出现该需求，需要在 `owner_uid` 之外增加共享关系表，而不是调整等级。
- **等级是全局的，不分业务域**：一个账号在所有表上是同一个等级，无法做到"在 A 业务是 2 级、在 B 业务是 0 级"。
- **可见性的调整权集中在管理员**：放弃 `perm_mode` 意味着账号无法自行设置某条记录的可见性（原 `chmod`），可见性完全由等级决定，而等级只有 `admin` 能改。
- **子查询开销**：每次 `select`/`count` 都会带一个针对用户表的 `IN` 子查询。用户表通常很小，可接受；必要时为 `perm_level` 建索引，为 `owner_uid` 建 `(owner_uid, deleted_at)` 复合索引。
- **JOIN 覆盖**：现有 `deleted_at` 谓词会作用于每个关联表，本需求的谓词若照做会使 WHERE 膨胀且基本无法走索引，因此只作用于主表。关联表若含敏感数据，需要业务查询显式限制。
- **未绑定主体即放行**：这是绕过机制的代价，靠"绑定点唯一"和冒烟用例约束，不靠类型系统保证。
