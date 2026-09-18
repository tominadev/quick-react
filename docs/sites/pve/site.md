# PVE 站点需求

## 目标

PVE 站点用于统一管理 Proxmox VE 集群节点、地区、实例规格和已分配的虚拟机编号，为后续 VPS 销售站点提供可靠的基础设施 API。

第一阶段只实现 PVE 资源管理和 VMID 分配，不实现商品销售、支付和客户订单页面。

## 站点边界

- PVE 站点负责节点、资源池、VMID、实例生命周期和 PVE API 调用。
- VPS 站点负责商品展示、客户购买、续费和客户侧实例操作。
- Wallet 站点负责余额、订单支付和账单。
- Passport 只负责身份认证，PVE 角色和权限由 PVE 站点维护。
- 业务站点之间通过服务间 API 调用，不直接读取对方数据库。

## 核心概念

### Region（地区）

数据表：`pve_regions`

地区是面向用户和运营人员的资源区域，例如“香港”“新加坡”“德国”。地区不是 PVE API 的 `node`，也不是云厂商 Region ID。

建议字段：

- `id`：系统唯一 ID
- `code`：唯一地区代码，例如 `hk`、`sg`
- `name`：中文名称
- `display_name`：对外显示名称
- `status`：`enabled` / `disabled`
- `sort_order`
- `created_at`、`updated_at`

约束：

- `code` 全局唯一。
- 已被节点或商品使用的地区不能物理删除，只能停用。
- 停用地区后不能新增节点、规格库存或 VM，但历史数据仍可查询。

### PVE Node（节点）

数据表：`pve_nodes`

节点指可以连接并管理的 PVE 主机或集群节点。界面统一称“节点”，避免与地区混淆。

建议字段：

- `id`：系统唯一 ID
- `region_id`：所属地区，必填
- `name`：节点名称，必填
- `host`：PVE API 地址或主机名，必填
- `port`：API 端口，默认 `8006`
- `cluster_name`：所属集群名称，可为空
- `api_user`：PVE API 用户名，必填
- `api_token_id`：PVE API Token ID，必填
- `api_token_secret`：PVE API Token Secret，必填；当前阶段按主人要求明文保存
- `status`：`enabled` / `disabled` / `error`
- `last_checked_at`
- `last_error`
- `created_at`、`updated_at`

约束：

- 新增节点时必须选择一个已启用的 Region。
- `host`、`port` 和凭据不能直接暴露给客户。
- `api_token_secret` 禁止出现在 API 响应、列表数据、错误信息和日志中。
- 节点停用后不能分配新 VM，但不影响已有 VM 的查询和生命周期管理。
- 删除节点前必须确认没有运行中的 VM 或未完成任务；通常只允许停用。

### 实例规格（Instance Flavor）

数据表：`pve_instance_flavors`

实例规格只描述可分配的 CPU 和内存，例如 `1c1g`、`2c2g`、`2c4g`，不包含磁盘、带宽或网络配置。

建议字段：

- `id`：系统自动生成的唯一 ID，新增时不可手动填写
- `code`：管理员填写的规格代码，例如 `1c1g`，用于展示和接口引用
- `name`：规格名称
- `cpu_cores`：CPU 核数，正整数
- `memory_gb`：内存，单位 GB，正整数
- `status`：`enabled` / `disabled`
- `sort_order`
- `created_at`、`updated_at`

约束：

- `(cpu_cores, memory_gb)` 建立联合唯一索引，同 CPU 核数和内存不能重复创建规格。
- `code` 只允许小写字母、数字和短横线，不作为规格唯一约束。
- 规格停用后不能用于新订单，但历史 VM 仍保留原规格快照。
- 创建 VM 时必须保存规格快照，避免规格后续修改影响历史实例账单和资源记录。
- 磁盘容量和带宽均不属于实例规格；后续单独设计存储、磁盘和网络配置，避免 CPU、内存规格与其他产品能力耦合。

### VM

数据表：`pve_vms`

VM 表记录由本系统分配并在 PVE 上创建的实例。第一阶段名称统一使用 VM，后续可通过 `kind` 扩展 LXC。

建议字段：

- `id`：数据库自动生成的自增 ID，同时作为 PVE VMID 使用
- `kind`：`qemu` / `lxc`，默认 `qemu`
- `region_id`：所属地区，必填
- `node_id`：实际节点，必填
- `instance_flavor_id`：创建时使用的实例规格，必填
- `name`
- `status`：`allocating` / `creating` / `running` / `stopped` / `error` / `deleting` / `deleted`
- `pve_status`：最近一次从 PVE 获取的状态
- `pve_config`：PVE 返回的必要配置快照，使用 JSON 或结构化字段保存
- `error_message`
- `created_at`、`updated_at`
- `deleted_at`

约束：

- `id` 是数据库自增 ID，写入 `pve_vms` 成功后取得该 ID，并将其作为 PVE 的 `vmid`。
- PVE `vmid` 直接映射 `id`，由数据库自增 ID 保证全局唯一，不再单独保存第二个编号。
- VMID 一旦分配不能回收给其他实例，即使实例创建失败或被删除，也保留记录，避免历史引用混乱。
- Region、Node、Instance Flavor 均必须保留外键关系或可追溯快照。
- 删除 VM 使用软删除或状态变更，不直接删除核心记录。

## VMID 分配规则

每次创建订单或实例时，必须先写入本系统的 `pve_vms`，再调用 PVE API 创建 VM：

1. 校验 Region、Node、Instance Flavor 均处于启用状态。
2. 先写入 `pve_vms`，状态为 `allocating`。
3. 获取数据库自动生成的 `id`，将其作为本实例的 PVE `vmid`。
4. 提交事务后调用 PVE API 创建 VM。
5. 调用成功后更新状态为 `creating` 或 `running`。
6. 调用失败时更新为 `error`，保存错误信息；该 ID 不回收。

VMID 分配依赖数据库自增 ID，不能在应用层自行计算编号。创建接口必须使用数据库返回的插入 ID，不能在写入失败时调用 PVE API。

建议配套数据表：

- `pve_vm_tasks`：记录创建、启动、停止、重启、删除等异步任务的幂等键、请求参数摘要、状态、重试次数和错误信息。

## 创建流程幂等性

- 每次创建请求必须有业务请求 ID 或幂等键。
- 相同幂等键重复提交时，返回原 VM 记录和当前状态，不重复创建 PVE VM。
- 数据库写入成功但 PVE 调用超时时，任务进入可重试状态，不能重新分配 VMID。
- PVE 创建操作必须记录请求参数、响应摘要、重试次数和最后错误。

## 节点选择

第一阶段允许管理员在创建 VM 时明确选择节点。后续可增加自动调度：

- 只能从选定 Region 内选择已启用节点。
- 节点健康检查失败或资源不足时不得分配。
- 自动调度必须记录选择原因和资源快照。

## 管理界面

PVE 管理后台至少包含：

- 地区管理
- 节点管理
- 实例规格管理
- VM 管理
- 创建 VM / 重试创建 / 启停 / 删除等操作
- 节点健康检查和最近错误
- VMID 分配记录和创建任务记录

所有新增、编辑和操作表单由后端下发字段和权限；前端只负责通用渲染。

## API 原则

- 页面路径与 API 路径保持对应，例如 `/panel/admin/pve/nodes.html` 对应 `/api/panel/admin/pve/nodes.php`。
- PVE 站点内部调用 PVE API 使用独立服务凭据，不使用用户 Cookie。
- VPS 站点调用 PVE 站点时使用服务间签名认证。
- 所有 PVE 操作返回统一响应协议，并提供任务状态查询。
- 不在业务代码中拼接 SQL，使用统一 SQL 助手。

## 后续扩展

- LXC 容器与 QEMU VM 共用实例模型，通过 `kind` 区分。
- 节点资源池、存储池、网络和 IPv4/IPv6 地址池。
- VPS 商品与规格绑定。
- Wallet 支付成功后触发 PVE 创建任务。
- 订单续费、到期停机和自动销毁。
