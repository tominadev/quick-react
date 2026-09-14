# SMS 接入方对接指南

写给**接入方**——用 SMS 平台替自己的用户接收短信的那一端。你需要做两件事：

1. **绑定手机**：签一张票据，让 SMS 把某个手机号登记到你的项目下，拿回一份 `.shortcut` 文件交给手机的主人；
2. **接收推送**：短信到达后 SMS 会 POST 给你，你验签、去重，然后用。

> **当前状态**：两部分都已上线，本文的代码可以直接跑。

全篇的编码规则只有一套：**摘要是小写十六进制，公钥与签名是 Base64URL（去掉 `=`），时间是 Unix 秒，请求与响应是 UTF-8 JSON。**

---

## 0. 准备

在 SMS 站点上（用你的账号登录）：

1. **控制台 → 短信 → 接入方**，新增一个（一个「项目」的意思：绑在它下面的手机、配在它下面的推送地址算作一组）。`标识`与`名称`都只给人看，不进协议。勾上「绑定手机」。
2. 在那一行点**公钥**，登记一把 Ed25519 公钥。`名称` 随便起（如「生产服务器」），只是给人看的标签。

   **这把公钥就是你的身份**——往后调接口只带它，不用再填接入方标识或账号 id。原理见 §1.0。一把公钥全平台只能登记一次。

   - 页面上有「在这台电脑上生成密钥对」，密钥对在**你的浏览器里**生成，私钥只显示一次、不上传。
   - 也可以在自己的机器上生成，只把公钥贴进去：

     ```bash
     openssl genpkey -algorithm ed25519 -out private.pem
     openssl pkey -in private.pem -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d '='
     ```

3. **控制台 → 短信 → 推送地址**，填一个 HTTPS 地址，`所属项目`选刚才那个接入方，`限定手机`按需要。

**私钥永远不要发给任何人，也不要提交进版本库。** SMS 只保存公钥，无法替你找回私钥——丢了就再生成一对，登记新公钥、把旧的改成「已退役」。

---

## 1. 绑定手机（票据路径）

### 1.0 SMS 怎么认出你是谁

**和 GitHub 放 SSH 公钥是同一回事。** 你在控制台登记一把公钥，往后每次调用都带上它：

```text
你发过来的票据
  ├── public_key  ──► SMS 在自己库里找到这一行（公钥全平台唯一，一查就定死）
  │                     ├── 是哪个接入方  ──► 手机挂到这个项目下，短信推给它配的地址
  │                     └── 属于哪个账号  ──► 手机登记到这个人名下
  └── signature   ──► 用刚找到的那把公钥验一遍，验过了才算数
```

所以你**不需要**再告诉 SMS「我是哪个接入方」「绑到哪个账号」——这两件事都是从公钥查出来的。
你填不错，也越不了权。

**为什么公钥要发过来？** Ed25519 的签名里恢复不出公钥（不像比特币那套 secp256k1 有
`ecrecover`）。不发的话，SMS 只能把库里每一把公钥挨个拿来试着验签——几百个接入方就是
几百次验签。SSH 也是这么做的：客户端先把公钥递过去，服务端在 `authorized_keys` 里找到它，
再验签。

**发公钥有风险吗？没有。** 公钥本来就是公开的，真正的凭证是那段签名。
把 `public_key` 填成别人的，就得拿**别人的私钥**才签得出能验过的签名——而私钥从不出你的门。
换句话说：**你只可能以你自己的身份绑定**，冒充别人这条路在数学上就是堵死的。

**换钥匙**：登记新的一把，两把并存一段时间（两把签的票据都验得过），等在途的票据都用完了，
再把旧的改成「已退役」——退役之后它签的新票据立刻失效。

### 1.1 票据长什么样

对一段**固定字段顺序**的 UTF-8 JSON 签名：

```json
{
  "v": 1,
  "aud": "sms",
  "public_key": "DlBJkchCqWE0khIVXMXVsr4Fg2v4y6ZMNAFiVlneVzw",
  "phone": "+8613800138000",
  "iat": 1788432000,
  "exp": 1788432300,
  "nonce": "8Xr2mQ..."
}
```

| 字段 | 说明 |
| --- | --- |
| `v` | 协议版本，固定 `1` |
| `aud` | 固定 `"sms"`。**这不是形式**：没有它，一张签给别的系统的票据可以拿来换你这里的绑定 |
| `public_key` | **你登记的那把公钥**，原样填。SMS 据此反查出接入方与归属账号——这是票据里唯一的身份字段 |
| `phone` | **规范化后的 E.164**，例如 `+8613800138000`。不要传 `13800138000` |
| `iat` / `exp` | Unix 秒。**有效期不超过 5 分钟**，允许的时钟偏差 60 秒 |
| `nonce` | 高熵随机串。同一个接入方内不得重复——SMS 按它挡重放 |

传输格式是两段 Base64URL 用点连接：

```text
base64url(票据 JSON 的 UTF-8 字节).base64url(Ed25519 签名)
```

**签名的输入就是你实际发出去的那串 JSON 字节。** 不要签一份、发另一份——重新序列化一次，键序或空格差一点，验签就过不去。稳妥的做法是先把 JSON 字符串拼好，再对它签名、再把同一个字符串编码进票据。

### 1.2 签票据

PHP（`ext-sodium`，PHP 7.2+ 自带）：

```php
<?php
// 你登记的那把公钥，照抄「公钥已登记」弹窗里那一行（见 §0 第 2 步）
$publicKey = 'DlBJkchCqWE0khIVXMXVsr4Fg2v4y6ZMNAFiVlneVzw';

$payload = json_encode([
    'v' => 1,
    'aud' => 'sms',
    'public_key' => $publicKey,
    'phone' => '+8613800138000',
    'iat' => time(),
    'exp' => time() + 300,
    'nonce' => rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '='),
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

// private.pem 里是 PKCS#8；sodium 要的是 64 字节的原始私钥
$pem = file_get_contents('private.pem');
$der = base64_decode(preg_replace('/-----[^-]+-----|\s/', '', $pem));
$seed = substr($der, -32);                       // PKCS#8 尾部就是 32 字节种子
$keyPair = sodium_crypto_sign_seed_keypair($seed);
$secret = sodium_crypto_sign_secretkey($keyPair);

$signature = sodium_crypto_sign_detached($payload, $secret);
$b64url = fn (string $raw): string => rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
$ticket = $b64url($payload) . '.' . $b64url($signature);
```

Node.js（无需依赖）：

```js
import { createPrivateKey, sign, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// 你登记的那把公钥，照抄「公钥已登记」弹窗里那一行（见 §0 第 2 步）
const publicKey = 'DlBJkchCqWE0khIVXMXVsr4Fg2v4y6ZMNAFiVlneVzw';

const b64url = (buffer) => buffer.toString('base64url');
const payload = JSON.stringify({
  v: 1,
  aud: 'sms',
  public_key: publicKey,
  phone: '+8613800138000',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 300,
  nonce: b64url(randomBytes(18)),
});
const privateKey = createPrivateKey(readFileSync('private.pem'));
// Ed25519 的第一个参数固定传 null：算法本身已经定死了摘要
const ticket = `${b64url(Buffer.from(payload))}.${b64url(sign(null, Buffer.from(payload), privateKey))}`;
```

### 1.3 提交票据，拿回下载链接

```http
POST https://sms.example.com/api/client/phone-bind.php
Content-Type: application/json

{ "ticket": "<base64url(票据 JSON)>.<base64url(签名)>", "title": "客户的机器" }
```

**路径末尾的 `.php` 是站点的 API 后缀**，由站点配置决定（后台 → 技术栈）。你对接的那个站点若配的是空后缀，路径就是 `/api/client/phone-bind`。拿不准就问一句，别猜——猜错拿到的是 404。

`title` 可选，是给手机起的名字，用户在自己的列表里看得到。

这个接口**不认 cookie，只认票据**，因此可以从你自己的页面跨源直接提交（已放行 CORS，但不放行凭证——`fetch` 不要带 `credentials`）。带着 cookie 打过来会被直接拒掉：浏览器会对跨站请求自动附带 cookie，这里若也认会话，任何网页都能借用户已登录的身份来打。

另一条路是把票据放进绑定页地址的**片段**里（`#` 之后），让用户在浏览器里打开：

```text
https://sms.example.com/panel/user/sms/bind#<ticket>
```

**放片段而不是查询参数**：片段不会出现在 Referer、服务器访问日志和第三方分析里。页面读到之后立刻清掉它，再提交给上面那个接口。

绑定成功的响应里带一个**短期下载地址**：

```json
{
  "number": "+8613800138000",
  "download_url": "https://…/shortcuts/…?X-Amz-Signature=…",
  "already_bound": false,
  "reissued": false,
  "expires_in": 900,
  "feedback": { "component": "modal", "type": "success", "message": "绑定成功" }
}
```

`already_bound` 为 `true` 表示这个号码之前就在你的项目下绑过了——这时**不会**新建记录，但仍然照常回一个新的下载地址。

`reissued` 为 `true` 表示那部手机**原来的快捷指令已经失效**（平台清理或撤销了它的令牌），这次换发了一份新的。手机上装着的旧快捷指令不能再用了：请让手机的主人删掉旧的、装上这一份，并把「自动化」改成运行新的这个。链接发出去客户没点、15 分钟过期了，**换一张新票据再绑一次同一个号码**就是重新取链接的办法。

### 1.4 失败了怎么办

| HTTP | 提示 | 该怎么处理 |
| --- | --- | --- |
| 400 | 绑定票据格式不正确 / 受众不匹配 / 版本不支持 | 代码问题，照 §1.1 对字段 |
| 400 | 绑定票据已过期或尚未生效 / 有效期过长 | `exp - iat` 不得超过 300 秒；检查机器时钟 |
| 400 | 手机号码格式不正确 | 传 E.164，例如 `+8613800138000` |
| 400 | 票据格式已简化…… | 你还在发老格式（`client_id` + `kid` + `base_user_id`）。改成一个 `public_key` 字段 |
| 401 | 这把公钥没有登记，或者已经退役 | 到控制台「接入方公钥」登记，或检查是不是用了已退役的那把 |
| 401 | 绑定票据签名无效 | 私钥与填的公钥对不上，或签的字节和发的字节不是同一串 |
| 401 | 这把公钥所属的接入方已停用 | 到控制台把接入方改回「启用」 |
| 403 | 这个接入方没有绑定手机的权限 | 到控制台给这个接入方勾上「绑定手机」 |
| 409 | 绑定票据已使用 | nonce 一次性。**重试要换一张新票据**，不能重发同一张 |
| 503 | 令牌池空了 | 平台侧要补 `.shortcut` 令牌，联系管理员 |

**nonce 一旦消费，票据立刻作废**——即便后面的步骤失败也不退回。这是有意的：宁可让你重签一张，也不能留下「同一张票据还能再绑一次」的口子。所以重试逻辑里请每次都重新生成 `nonce` 与 `iat`/`exp`。

把它交给手机的主人，**在那部手机上打开**下载并添加快捷指令。

**添加之后还要设一条自动化，否则一条都不会转发**——iOS 的快捷指令不会自己在收到短信时运行。请把这一步一并告诉手机的主人：

> 打开「快捷指令」App →「自动化」→ 新建「信息」自动化，选「立即运行」，动作选刚添加的这个快捷指令。设好之后手动运行一次，看到「测试成功」和自己的号码就说明通了。

手动运行只能证明手机连得上平台，**证明不了自动化设好了**（手动运行时两者看起来一样）。真正的验证是发一条短信到那部手机，看你的服务器有没有收到推送。

地址 15 分钟内有效，过期可以重新获取。下载下来的文件名是「你的项目名-号码后四位.shortcut」，同一个人收到好几个项目的文件时认得出哪个是哪个。

> **绑定不等于收得到短信。** 那份 `.shortcut` 有没有被装进那部手机是物理动作——装上了说明手机的主人同意了，那本来就是授权；没装上，你拿到的只是一条永远收不到短信的记录。

---

## 2. 接收推送

短信到达后，SMS 会 POST 到你配的推送地址。

### 2.1 请求长什么样

```http
POST /sms-hook HTTP/1.1
Content-Type: application/json
X-Sms-Timestamp: 1788432000
X-Sms-Delivery-Id: 32b38649-5a19-41a6-a0fd-24810b7b660b
X-Sms-Key-Id: b20113c86e8b51dd
X-Sms-Signature: ed25519=IUA-_IJLSTI8…

{"delivery_id":"32b38649-…","phone":"+861380013****","content":"【测试】验证码 8848","sender":"10086","recipients":null,"received_at":1788744955069}
```

| 字段 | 说明 |
| --- | --- |
| `delivery_id` | 本次投递的稳定标识，**重试时不变**，按它去重 |
| `phone` | 来源手机的**掩码**号码。完整号码不会推给你 |
| `content` | 短信正文 |
| `sender` | 发送方号码，可能为 `null` |
| `recipients` | 收件人，可能为 `null` |
| `received_at` | 手机收到短信的时刻，毫秒 |

### 2.2 验签（必做）

**签名的输入是 `X-Sms-Timestamp` + `.` + 原始请求体字节。** 是「原始字节」——不要先 JSON 解析再重新序列化，那样键序或空格差一点就验不过。先留住 raw body，再验签，最后才解析。

验签步骤：

1. 取 `X-Sms-Key-Id`，在你缓存的公钥里找；
2. 找不到就拉一次 `GET https://sms.example.com/api/push-key`（**公开，不需要凭证**），更新缓存；
3. 用那把公钥验 `X-Sms-Signature`（去掉 `ed25519=` 前缀，Base64URL 解码）；
4. 验 `X-Sms-Timestamp` 与当前时间相差不超过 5 分钟；
5. 按 `delivery_id` 去重。

公钥端点返回：

```json
{
  "algorithm": "Ed25519",
  "keys": [
    { "kid": "b20113c8…", "public_key": "ilpfq5M8…", "status": "active" },
    { "kid": "94cb61ff…", "public_key": "mrV6VfiF…", "status": "retiring" }
  ]
}
```

**`keys` 是数组，按 `kid` 挑。** 轮换期间会有两把：`active` 是当前签名用的，`retiring` 是刚换下来、还在重试窗口里的。不要假设只有一把，也不要假设第一把就是签名那把。

**要缓存，不要每收一条推送就拉一次。** 正常情况下一个请求都不会发；只有轮换之后第一次遇到新 `kid` 才拉一次。

PHP：

```php
<?php
$raw = file_get_contents('php://input');
$timestamp = (int) ($_SERVER['HTTP_X_SMS_TIMESTAMP'] ?? 0);
$keyId = $_SERVER['HTTP_X_SMS_KEY_ID'] ?? '';
$signature = str_replace('ed25519=', '', $_SERVER['HTTP_X_SMS_SIGNATURE'] ?? '');

if (abs(time() - $timestamp) > 300) { http_response_code(400); exit('timestamp out of window'); }

$b64urlDecode = fn (string $value): string => base64_decode(strtr($value, '-_', '+/') . str_repeat('=', (4 - strlen($value) % 4) % 4));
$publicKey = $b64urlDecode(lookupPublicKey($keyId));   // 见下：带缓存
if (!sodium_crypto_sign_verify_detached($b64urlDecode($signature), "{$timestamp}.{$raw}", $publicKey)) {
    http_response_code(401);
    exit('bad signature');
}

$message = json_decode($raw, true);
if (alreadyHandled($message['delivery_id'])) { http_response_code(200); exit('ok'); }
handle($message);
http_response_code(200);

function lookupPublicKey(string $kid): string {
    $cache = apcu_fetch('sms_push_keys') ?: [];
    if (isset($cache[$kid])) return $cache[$kid];
    $fetched = json_decode(file_get_contents('https://sms.example.com/api/push-key'), true);
    foreach ($fetched['keys'] as $key) $cache[$key['kid']] = $key['public_key'];
    apcu_store('sms_push_keys', $cache, 86400);
    if (!isset($cache[$kid])) { http_response_code(401); exit('unknown key id'); }
    return $cache[$kid];
}
```

Node.js（Express，注意要拿 raw body）：

```js
import express from 'express';
import { createPublicKey, verify } from 'node:crypto';

const app = express();
// 关键：留住原始字节。用 express.json() 解析过再 JSON.stringify 回去，验签必然失败。
app.use('/sms-hook', express.raw({ type: 'application/json' }));

const keyCache = new Map();
const lookupPublicKey = async (kid) => {
  if (keyCache.has(kid)) return keyCache.get(kid);
  const response = await fetch('https://sms.example.com/api/push-key');
  for (const item of (await response.json()).keys) {
    // Ed25519 的 SPKI 前缀固定，拼上就能交给 createPublicKey
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(item.public_key, 'base64url')]);
    keyCache.set(item.kid, createPublicKey({ key: spki, format: 'der', type: 'spki' }));
  }
  return keyCache.get(kid);
};

app.post('/sms-hook', async (request, response) => {
  const timestamp = Number(request.get('x-sms-timestamp') ?? 0);
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return response.status(400).send('timestamp out of window');
  const key = await lookupPublicKey(request.get('x-sms-key-id') ?? '');
  if (!key) return response.status(401).send('unknown key id');
  const signature = Buffer.from((request.get('x-sms-signature') ?? '').replace('ed25519=', ''), 'base64url');
  if (!verify(null, Buffer.from(`${timestamp}.${request.body}`), key, signature)) return response.status(401).send('bad signature');

  const message = JSON.parse(request.body.toString('utf8'));
  if (await alreadyHandled(message.delivery_id)) return response.sendStatus(200);
  await handle(message);
  response.sendStatus(200);
});
```

### 2.3 为什么一定要验签

HTTPS 只保证「我连的是对的服务器」，**不保证「这条 POST 是谁发的」**。任何知道你 webhook 地址的人都能往那里发一条「您的验证码是 123456」，不验签你的系统无从分辨。

（不用共享密钥而用 Ed25519，是因为对称密钥要逐个端点分发、存储、轮换——一百个推送地址就是一百把钥匙。）

### 2.4 回什么

- **成功处理**：回 `2xx`。SMS 据此标记投递成功。
- **暂时处理不了**：回任意非 `2xx`，SMS 会重试——间隔 1 分钟、5 分钟、30 分钟、2 小时、6 小时，五次之后放弃。
- **重复收到**：仍然回 `2xx`。重试期间同一条会带**同一个 `delivery_id`**，你按它去重即可；回错误只会让它继续重试。

响应体不会被读取，但**不要回几十 KB 的错误页**——SMS 只记状态码。

---

## 3. 排错

| 现象 | 多半是什么 |
| --- | --- |
| 绑定报「这把公钥没有登记」 | 票据里的 `public_key` 与控制台登记的那一串不是同一个；或者那把已经退役 |
| 绑定报「绑定票据签名无效」 | 私钥与填的公钥不是一对；或者签的字节和发出去的字节不是同一串 |
| 验签总是失败（推送那半） | 先 JSON 解析再重新序列化了。签名的输入是**原始请求体字节** |
| 轮换之后开始失败（推送那半） | 公钥缓存没有按 `kid` 索引，或者拿到新 `kid` 时没有重新拉。**这个 `kid` 是平台签推送用的，与你签票据的钥匙无关** |
| `unknown key id` | 缓存过期时间太长且没有按 `kid` 回源 |
| 同一条短信处理了两次 | 没按 `delivery_id` 去重。重试沿用同一个值 |
| 收不到任何推送 | 推送地址的**所属项目**要与手机登记的项目一致；地址状态是否为「启用」；地址是否 HTTPS |
| 推送地址存不进去 | 必须是 `https://`，且不能指向内网、回环或链路本地地址（服务端每次投递前还会按解析结果再判一次） |

---

## 4. 轮换你的签票密钥

**两把并存，切过去，再退役旧的。** 中间没有一秒钟是断的：

1. 生成一把新密钥对，登记公钥（名称随便起个新的），状态 `启用中`。这时两把都能验过；
2. 你的服务端切换到新私钥签票，票据里的 `public_key` 跟着换成新那把；
3. 等 5 分钟——票据有效期最长就 5 分钟，过了就没有在途的旧票据了；
4. 把旧那把改成 `已退役`。退役之后用它签的票据立即被拒。

**退役或删除过的公钥不能再登记回来**（同一把公钥全平台只登记一次）。要「换回去」只能
再生成一对新的——本来也该这么做：一把退役过的钥匙，退役的理由多半还在。
