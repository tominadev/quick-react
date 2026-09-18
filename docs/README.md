# 文档目录

```text
docs/
  sites/        按站点分，目录名与代码一致
  project/      这个仓库本身：架构、开发、部署、配置、安全、接口
  conventions/  跨全站的约定
  postmortems/  事故复盘
  releases/     每次发布的交接与审计资料，一个版本一个目录
```

**站点文档和代码用同一个名字**：`prisma/<site>.prisma`、`server/modules/<site>/`、
`server/routes/<site>/`、`<site>_*` 数据表、`/panel/admin/<site>`，文档就在 `docs/sites/<site>/`。
站点在代码里从不出现在顶层，永远挂在一个说明类别的父目录下（`server/routes/`、`server/modules/`），
文档同理挂在 `docs/sites/` 下。

## project —— 这个仓库本身

| 文档 | 主题 |
| --- | --- |
| [architecture](project/architecture.md) | 构建启动流程、站点路由与整体结构 |
| [development](project/development.md) | 开发指南 |
| [deployment](project/deployment.md) | 部署指南 |
| [configuration](project/configuration.md) | 环境变量与配置项 |
| [security](project/security.md) | 安全说明 |
| [api](project/api.md) | 已实现的接口 |
| [optimization-checklist](project/optimization-checklist.md) | 持续优化清单（待办勾选表，不是约定） |

## sites/base —— 公共后台能力

| 文档 | 主题 | 提出 |
| --- | --- | --- |
| [backend-driven-ui-and-navigation](sites/base/backend-driven-ui-and-navigation.md) | 后端驱动页面、导航与表格表单协议 | 2026-08-23 |
| [row-level-data-ownership](sites/base/row-level-data-ownership.md) | 数据行归属字段与写入逻辑（owner_uid） | 2026-09-01 |
| [data-visibility-and-delegated-access](sites/base/data-visibility-and-delegated-access.md) | 租户与分站归属、可见性判定与代用户操作（owner_tid / owner_bid） | 2026-09-04 |
| [agent-tenants-and-management-views](sites/base/agent-tenants-and-management-views.md) | 代理用户关系、管理视图、受限代查与计费归集 | 2026-09-04 |
| [change-audit-and-revert](sites/base/change-audit-and-revert.md) | 变更留痕、撤回与审计保留期 | 2026-09-04 |
| [maintenance-toolbox](sites/base/maintenance-toolbox.md) | 维护工具箱、救援入口与配置恢复 | 2026-09-01 |

## sites/global —— 全局控制面

| 文档 | 主题 | 提出 |
| --- | --- | --- |
| [site-database-routing-and-isolation](sites/global/site-database-routing-and-isolation.md) | 多站点路由、站点继承与数据库隔离 | 2026-08-15 |
| [cloud-capability-management](sites/global/cloud-capability-management.md) | 云凭据与云能力管理 | 2026-08-25 |
| [object-storage-management](sites/global/object-storage-management.md) | 对象存储桶、绑定与对象管理 | 2026-08-25 |

## sites/passport —— 身份中心（对外叫 Accounts）

| 文档 | 主题 | 提出 |
| --- | --- | --- |
| [telegram-integration](sites/passport/telegram-integration.md) | Passport 身份中心、Telegram 集成与 OIDC | 2026-08-26 |
| [account-center](sites/passport/account-center.md) | 用户名/密码补全、登录页与账户中心 | 2026-08-27 |
| [local-accounts](sites/passport/local-accounts.md) | 本站账号与 Accounts 并存：登录开关、自助改资料、撞名绑定与密码同步 | 2026-09-04 |

## sites/sms —— 短信接收平台

| 文档 | 主题 | 提出 |
| --- | --- | --- |
| [site-and-ed25519-binding](sites/sms/site-and-ed25519-binding.md) | SMS 站点、数据模型、Ed25519 绑定协议与接收流程 | 2026-09-04 |
| [shortcut-generator](sites/sms/shortcut-generator.md) | Mac Shortcut 生成器：令牌预生成、上传与入库 | 2026-09-04 |
| [generator-ed25519-auth](sites/sms/generator-ed25519-auth.md) | Mac 生成器从预配凭证改用 Ed25519 签名 | 2026-09-18 |
| [client-integration](sites/sms/client-integration.md) | **写给接入方**的对接指南（描述现状，可直接照着跑） | — |

## sites/pve

| 文档 | 主题 | 提出 |
| --- | --- | --- |
| [site](sites/pve/site.md) | PVE 站点 | 2026-08-29 |

## sites/loki

| 文档 | 主题 | 提出 |
| --- | --- | --- |
| [log-center](sites/loki/log-center.md) | 日志中心：Loki 边界、多租户、源站凭据与查询页 | 2026-09-17 |

## conventions —— 跨全站的约定

| 文档 | 主题 | 提出 |
| --- | --- | --- |
| [column-naming](conventions/column-naming.md) | 列命名约定：id / key / name / title | 2026-09-05 |
| [ai-agent-boundaries](conventions/ai-agent-boundaries.md) | AI agent 的称谓、身份与数据访问边界 | 2026-08-28 |

## postmortems —— 事故复盘

| 文档 | 主题 | 提出 |
| --- | --- | --- |
| [table-switch-stale-ui](postmortems/table-switch-stale-ui.md) | 数据管理切换表格时 UI 混合问题 | — |

## releases —— 发布资料

[v1.0-beta](releases/v1.0-beta/README.md)：发布前的数据库命名与结构审计、阻断项和交接顺序。
它是某个时间点的交接资料，不替代 `sites/` 下各站点的业务需求。

## 写作约定

- 需求文档记录**已确认**的功能需求和对应的设计决策，实现完成后在文档里更新状态，不删除历史需求。
- **每篇需求文档的标题下面紧跟一个头部块**，顺序固定，`上游需求` 没有就不写：

  ```text
  - 提出日期：2026-09-04
  - 状态：已实施（2026-09-04）。留痕与回滚已落地；仍未做的见 §14。
  - 涉及范围：base 站点；波及 global、passport、sms 的受管写入
  - 上游需求：[data-visibility-and-delegated-access](../base/data-visibility-and-delegated-access.md)
  ```

  由 `npm run test:doc-schema-refs` 守着，缺字段就失败。

  **`状态` 要能被推翻。** 写「已实施」就要能指出代码在哪；部分实施就写清哪几节没做；说不准的写
  「**待逐条核对**」并附上已经知道的事实，不要填一个看起来完整的猜测——读的人分不出猜测和结论。
  日期一律绝对日期。**文件名里不放日期**：这些是活文档，找它们靠主题；靠时间找的是 `postmortems/`。
- 每个需求文档包含：背景、目标、详细规则、数据结构变更、验收标准。
- 规则写成可验证的条目，避免"优化体验"这类无法验收的描述。
- 相对时间一律写成绝对日期。
- 文档里的"用户"一律指网站终端用户；给 agent 下指令的人称为"主人"，称谓约定见 [AGENTS.md](../AGENTS.md)。
- 新需求必须先对照既有文档，冲突时在新文档里写明取舍理由。
- **站点相关的文档放进对应的 `docs/sites/<site>/`，文件名不重复站点名**：
  `docs/sites/sms/shortcut-generator.md`，不是 `docs/sites/sms/sms-shortcut-generator.md`——
  与「实体表内部的业务字段不重复实体前缀」是同一条规则。
- **新增描述现状的文档（对接指南、架构说明）要在 `scripts/test-doc-schema-refs.mjs` 里登记**，
  否则文档里写错的表名列名没有任何人会查。需求文档写的是目标状态，登记为不查。
