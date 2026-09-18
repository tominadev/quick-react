# SMS Shortcut 生成器（macOS）

在平台侧的 Mac 上批量生成带唯一令牌的**已签名** `.shortcut`，走 SMS 平台的
`config → prepare-upload → PUT → commit` 登记为可领取令牌。

需求与协议见 [docs/sites/sms/shortcut-generator.md](../../../docs/sites/sms/shortcut-generator.md)，
站点数据模型见 [site-and-ed25519-binding.md](../../../docs/sites/sms/site-and-ed25519-binding.md)。
本文只讲怎么用。

**为什么必须是 Mac**：签名（`shortcuts sign --mode anyone`）是一次约 5~6 秒的苹果云端往返，
只有 macOS 有 `/usr/bin/shortcuts`，而且**必须跑在已登录 iCloud 的图形会话里**——所以无人值守
只能用用户级 LaunchAgent，不能用 root/LaunchDaemon。这也是要提前批量预签成一个池子的原因：
用户领取时只是一次数据库更新，毫秒级返回。

## 配置

```sh
cp .env.example .env && chmod 600 .env    # 填端点和凭证
```

`.env` 整份由 SMS 后台的「生成机器」管理页在创建或重置凭证时生成，运维复制到对应的 Mac 即可。
取值优先级是**环境变量 > `.env` > 编译时内置**，命令行版和图形版走同一条路径。

## 用

**双击**（macOS，Finder 用「终端」执行）：

- **`run.command`** —— 直接用：源码/模板/`.env` 有更新时自动重编，问你补到几个（回车 = 只做连接自检），跑完等你按键关窗。
- **`build.command`** —— 只编译，命令行版和图形版都编。
- **`SMS生成器.app`** —— 图形版，编出来之后双击即可；有「自检 / 开始补货 / 停止」。

首次双击若被 Gatekeeper 拦，右键 →「打开」允许一次即可。

**命令行**：

```sh
./build.sh                                   # 编译，产出 ./shortcut-generator
./shortcut-generator --check                 # 校验 .env / 可达性 / 凭证 / 余量 / 本地签名
./shortcut-generator --count 50              # 补货：维持池子有 50 个可用
./shortcut-generator --count 50 --interval 300   # 循环：每 300 秒补到 50 个
# 可选：--keep-local --task-id T --env <path> --state <path> --template <path>
```

**`--count` 是「目标可用数量」，不是「新增数量」**（需求文档 §5.2.1）：工具先拉 `config` 取
`pool.available`，只生成 `max(0, 目标 − 可用)` 个；已达标就提示「已有 N 个可用」并退出。所以
服务端删掉或回收令牌导致可用数下降后，**再跑一次就自动补回目标数**。顺序固定：先续完本地状态
文件里没做完的批次，再重新取余量，再用新 `task_id` 生成差额。

**无人值守**有两种，都必须跑在已登录 iCloud 的图形会话里（因此是用户级 LaunchAgent）：

1. **常驻循环**：`--count 50 --interval 300`（或 `.env` 里设 `TARGET_AVAILABLE`/`INTERVAL` 后无参运行），配 `KeepAlive` 保活。
2. **定时触发**：LaunchAgent 用 `StartInterval` 定期拉起 `--count 50`（补完就退出）：

```xml
<!-- ~/Library/LaunchAgents/local.sms.shortcut-replenish.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>local.sms.shortcut-replenish</string>
  <key>ProgramArguments</key>
  <array><string>/绝对路径/shortcut-generator</string><string>--count</string><string>50</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardErrorPath</key><string>/tmp/sms-replenish.log</string>
</dict></plist>
```

## 代码结构

```text
Sources/Core/     协议、签名、补货逻辑——命令行版和图形版共用这一份
  Support.swift     错误类型、摘要、随机令牌
  Settings.swift    .env / 环境变量 / 编译内置的取值优先级，模板加载
  Sign.swift        注入模板 + 调 /usr/bin/shortcuts 签名
  Client.swift      config / prepare-upload / PUT / commit / abort
  State.swift       断点续传的本地状态文件
  Replenish.swift   一轮补货：续旧批 → 取余量 → 生成差额
Sources/CLI/      只做参数解析、日志落点和退出码
Sources/GUI/      只做界面；「停止」按钮接到 Core 的 isCancelled
templates/        Shortcut 模板，占位符 __RECEIVE_URL__ / __TOKEN__
```

`Embedded.swift` 由构建脚本生成（把 `.env` 和模板编进二进制，编完挪到别处也能跑），
**不进版本库**。没有 `.env` 也能编译，内置值留空、运行时再读——干净检出的仓库必须能编译。

## 安全

- 令牌是 32 字节安全随机 → Base64URL，写进 Shortcut 的 `Authorization: Bearer`；`token_sha256`（小写 hex）只在 `commit` 提交。
- **原始令牌与 `token_sha256` 不进状态文件、日志、清单。** 因此没做完的条目无法从已签名文件恢复，只能重做；而 `commit` 成功前服务端没有记录，重做是安全的。
- `commit` 成功之前不删本地签名文件：它是那个令牌唯一的副本。
- 带凭证编出来的二进制和 `Embedded.swift` **含明文密钥**，已 gitignore，不要分享。

## 已知缺口（尚未修复，不得视为已实现）

- **凭证是平台铸造的长期明文口令**，与 AGENTS.md「平台是可信公钥登记处」的原则相反：`SMS_PROVISIONING_KEY` 躺在这台 Mac 的 `.env` 里、也被编进二进制，泄露之后一直有效，且二进制因此不能分享。改造方案见 [generator-ed25519-auth.md](../../../docs/sites/sms/generator-ed25519-auth.md)：密钥对在这台机器上生成、私钥进 Keychain，平台只登记公钥。落地之后二进制里就不该有任何秘密。
- **`token_sha256` 的取值口径尚未端到端确认。** 现在按「对写入 Bearer 的 Base64URL 字符串取 SHA-256」实现（`Support.swift` 里 `tokenSha256` 一处）。接收接口对未绑定设备的令牌统一回「设备不可用或凭证无效」，与「凭证无效」同一句话，**分不出哈希对错**；要用一个**已绑定设备**的令牌做端到端短信测试才能确认。口径不对的话改那一行即可。
- **服务端字段名仍在容错。** `prepare-upload` 的 PUT 地址、对象键在 `Client.swift` 里按几个常见命名依次取（联调期间服务端换过写法）。契约稳定后应收敛成单一字段名，容错本身会掩盖将来的改名。
