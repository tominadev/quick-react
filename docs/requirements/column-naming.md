# 列命名约定：id / key / name / title

## 为什么要定这条规矩

`name` 一词在库里同时表示两样东西：`base_users.name` 是登录用户名（英文数字、唯一），
`global_sites.name` 是「全局控制面」这样的中文显示名。读代码的人每次都要先判断这一处
是哪一种。`code` 与 `key` 也没有分工——五张表用 `key`，两张 pve 表用 `code`，而其中
`pve_instance_flavors.code` 根本不唯一，压根不是标识符。

## 四个词，三层职责

| 列 | 字符集 | 可变 | 唯一 | 能被别的表引用 | 干什么用的 |
| --- | --- | --- | --- | --- | --- |
| `id` | 数字 | 否 | 是 | **是，默认就用它** | 内部关联 |
| `key` | `[a-z][a-z0-9_]*` 或机器生成的 UUID | **否**（建后不改） | 是 | 是，外键列名 `<表单数>_key` | 要写进配置、路由、DSN、URL，人要读要写的标识 |
| `name` | 英文数字 | 是 | 是 | **否** | 登录名、技术名（`base_users.name`、`pve_nodes.name`） |
| `title` | 任意语言 | 是 | 通常否 | **否** | 给人看的名字 |

**判据是「能不能改」，不是「是不是英文」。** `base_users.name` 是纯英文数字，却绝对不能
被引用——用户随时能改自己的用户名，改完引用就断了。而 `global_sites.key` 能被八张表引用，
不是因为它是英文，是因为建站时定死、此后不改。字符集只是可变性的结果，不是原因。

`title` 默认不唯一。个别表为了防重名仍然可以加唯一约束（`global_cloud_credentials`、
`global_telegram_bots` 就是这样），但**唯一不等于可以被引用**——它照样会被人改。

## 每张表都有 `key`

`key` 是**每一行的稳定标识**，紧跟在 `id` 后面，`VARCHAR(36)`。值有三种来源，但角色是同一个：

| 值 | 谁给的 | 例子 |
| --- | --- | --- |
| 人给的短串 | 建表时定死，写进配置和 URL | `global_sites.key = 'passport'`、`base_configs.key = 'site_settings'` |
| 客户端 UUID | 客户端生成并回传 | `base_devices.key`、`passport_devices.key` |
| 雪花号 | SQL 构造器在 INSERT 时补 | 其余 54 张表 |

**一张表只有一个 `key`。** 已经有人给的 key 的表不再补雪花——两个都叫 key 就又回到了
`name` 那种一词两义。

**建后不改。** `key` 在 `SYSTEM_FIELD_NAMES` 里，更新路径一律挡掉——它能被别的表引用，
正是因为不动；改一次就把所有引用指向了空处。新建路径显式放行（`global_sites` 这类表的
key 是人给的），数据管理的新建表单也留着这一格，留空就交给发号器。

**36 字节封顶**：雪花最长 19 位（2⁶³−1），人给的短串更短，客户端 UUID 正好 36。
`VARCHAR(36)` 只管长度，字符集由**写入口**管：`sql.mts` 的 `assertRowKey` 挡住
`[A-Za-z0-9_-]` 以外的字符。CHECK 约束 Prisma schema 写不出来，手写又破坏了「迁移全部由
prisma 生成」，因此校验放在唯一必经之路上。

两张表没有 `key`，都是基础设施而不是业务数据：`global_snowflake_state`（发号要先读它，
给它加 key 就是死循环）和 `global_schema_migrations`（它在建库之前就要写入，那时号段还不存在）。

### 发号器

`server/modules/base/snowflake.mts`，全站共享，纪元与位宽沿用 Passport 老项目
（41 位毫秒 + 10 位 worker + 12 位序列），因为 `passport_users.key` 就是老库里的
`user_id`，值必须一模一样。

**发号是同步的**：`key` 由 SQL 构造器在每次 INSERT 时补上，那是个同步函数，没法 await。
因此号段一次预留 30000 个逻辑毫秒（一次写库，约 1.2 亿个号），之后全在内存里发，
快用完时在后台续。预留走 `advanceNumber` 的原子推进，两个进程即使配了同一个 worker id
也只会拿到彼此不相交的两段，重启后也不会把发过的号再发一遍。

**发出来的是字符串**，不是 BigInt。老实现返回 BigInt，于是每个读它的查询都得
`cast: 'text'`，漏一处就抛「Value is too large to be represented as a JavaScript number」；
而 `Number()` 那一路更糟——不报错，静默算成另一个数。字符串从源头上断了这两条路。

### worker id

`SNOWFLAKE_WORKER_ID`（0–1023）。环境变量优先，其次 `.env`；两处都没有就按
`/etc/machine-id`（拿不到就退回主机名）哈希后取模 1024，并**写回 `.env`**——
worker id 必须跨重启稳定，每次启动重新随机会让两次运行落在同一毫秒时产生重号。
`.env` 不进版本库。

取模会撞：两台机器可能算出同一个号。撞了不会立刻出错（号段是原子预留的），但会白白
消耗号段。集群规模上来之后应该显式配置，不要依赖推导。

## 配套规则

- **`code`、`display_name`、`label` 一律不用。** 一个概念一个词：标识用 `key`，显示名用 `title`。
- **默认用 `id` 关联。** 只有跨库、跨站点、或那个值本身要写进配置文件的，才用 `key`
  ——这解释了为什么 `site_key` 是字符串而 `region_id` 是数字，不是随手定的。
- **外键列名 = `<被引用表的单数>_<被引用列>`**：`site_key`、`region_id`、`user_id`、`email_id`。
- **`key` 的值用小写字母加下划线**：`site_settings`、`tech_stack`、`initial_admin`。
  URL 路径段按 web 惯例仍用连字符（`/panel/admin/base/settings/tech-stack.html`），
  两者是不同的命名空间——同一个概念在两处写法不同是有意的，不是漏改。

## 前端协议里的 `key` 是另一样东西

antd 的表格要求每一行有唯一的 `key`。**这个 `key` 与数据库的 `key` 列毫无关系**，早先
数据管理页把主键值合成成一个叫 `key` 的字段（`{ ...row, key: 主键值 }`），把
`base_configs`、`global_sites` 这些表**自己的 `key` 列覆盖成了 id**——列表上看着像
「key 存成数字了」，库里其实是好的。

现在的做法：`option.rowKey` 直接声明成这张表真实的主键列名，不再往行里塞字段。只有
**没有主键的只读表**才合成一个 `_row_key`（下划线前缀＝协议保留字段，与 `_pending`、
`_section` 一致，撞不上任何业务列）。

## 由测试守着

`npm run test:naming` 检查 prisma schema：
- 不出现 `code`、`display_name`、`label` 列；
- **每张表都有 `key`**，紧跟在 `id` 后面，声明 `@db.VarChar(36)`（例外只有发号器的状态表）；
- 每个 `key` 列都必须落在某个 `@@unique` 里（可被引用的标识必须唯一）；
- 不出现 `*_title` 形式的列（那意味着有人拿显示名当外键）。

`npm run test:sql-builder` 守着写入口：key 由构造器补、调用方给的不被覆盖、非法字符与
超长值被挡下。
