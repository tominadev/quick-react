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
- 每个 `key` 列都必须落在某个 `@@unique` 里（可被引用的标识必须唯一）；
- 不出现 `*_title` 形式的列（那意味着有人拿显示名当外键）。
