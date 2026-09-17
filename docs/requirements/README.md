# 需求文档

本目录记录已确认的功能需求和对应的设计决策，按主题命名，实现完成后在文档里更新状态，不删除历史需求。

v1.0 beta 发布前的数据库命名与结构审计、阻断项和交接顺序见 [docs/handoff/v1.0-beta](../handoff/v1.0-beta/README.md)。该目录是发布交接资料，不替代本目录中的业务需求。

| 文档 | 主题 |
| --- | --- |
| [backend-driven-ui-and-navigation](backend-driven-ui-and-navigation.md) | 后端驱动页面、导航与表格表单协议 |
| [site-database-routing-and-isolation](site-database-routing-and-isolation.md) | 多站点路由、站点继承与数据库隔离 |
| [passport-and-telegram-integration](passport-and-telegram-integration.md) | Passport 身份中心、Telegram 集成与 OIDC |
| [accounts-account-center](accounts-account-center.md) | Accounts 用户名/密码补全、登录页与账户中心 |
| [ai-agent-boundaries](ai-agent-boundaries.md) | AI agent 的称谓、身份与数据访问边界 |
| [cloud-capability-management](cloud-capability-management.md) | 云凭据与云能力管理 |
| [object-storage-management](object-storage-management.md) | 对象存储桶、绑定与对象管理 |
| [row-level-data-ownership](row-level-data-ownership.md) | 数据行归属字段与写入逻辑（owner_uid） |
| [data-visibility-and-delegated-access](data-visibility-and-delegated-access.md) | 租户与分站归属、可见性判定与代用户操作（owner_tid / owner_bid） |
| [agent-tenants-and-management-views](agent-tenants-and-management-views.md) | 代理用户关系、管理视图、受限代查与计费归集 |
| [change-audit-and-revert](change-audit-and-revert.md) | 变更留痕、撤回与审计保留期 |
| [local-accounts-alongside-passport](local-accounts-alongside-passport.md) | 本站账号与 Accounts 身份并存：登录开关、自助改资料、撞名绑定与密码同步 |
| [optimization-checklist](optimization-checklist.md) | 持续优化清单 |
| [maintenance-toolbox](maintenance-toolbox.md) | 维护工具箱、救援入口与配置恢复 |
| [sms-site-and-ed25519-binding](sms-site-and-ed25519-binding.md) | SMS 站点、数据模型、Ed25519 绑定协议与接收流程 |
| [sms-generator-ed25519-auth](sms-generator-ed25519-auth.md) | Mac 生成器从预配凭证改用 Ed25519 签名 |
| [sms-shortcut-generator](sms-shortcut-generator.md) | Mac Shortcut 生成器：令牌预生成、上传与入库 |
| [log-center](log-center.md) | 日志中心：Loki 边界、多租户、源站凭据与查询页 |

## 写作约定

- 每个需求文档包含：背景、目标、详细规则、数据结构变更、验收标准。
- 规则写成可验证的条目，避免"优化体验"这类无法验收的描述。
- 相对时间一律写成绝对日期。
- 文档里的"用户"一律指网站终端用户；给 agent 下指令的人称为"主人"，称谓约定见 [AGENTS.md](../../AGENTS.md)。
- 新需求必须先对照既有文档，冲突时在新文档里写明取舍理由。
