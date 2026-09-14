# SMS 接入方对接指南

写给**接入方**——用 SMS 平台替自己的用户接收短信的那一端。你需要做两件事：

1. **绑定手机**：签一张票据，让 SMS 把某个手机号登记到你的项目下，拿回一份 `.shortcut` 文件交给手机的主人；
2. **接收推送**：短信到达后 SMS 会 POST 给你，你验签、去重，然后用。

> **当前状态**：两部分都已上线，本文的代码可以直接跑。

全篇的编码规则只有一套：**摘要是小写十六进制，公钥与签名是 Base64URL（去掉 `=`），时间是 Unix 秒，请求与响应是 UTF-8 JSON。**

---

## 0. 准备

在 SMS 站点上（用你的账号登录）：

1. **控制台 → 短信 → 接入方**，新增一个。`标识` 就是协议里的 `client_id`（例如 `shop`），`名称`给人看。
2. 在那一行点**公钥**，登记一把 Ed25519 公钥。`kid` 建议用启用日期（`2026-09-01`），换钥匙时换一个新的。

   **登记成功的弹窗里会把票据要填的 `client_id`、`kid`、`base_user_id` 三个值一起报出来，照着抄。** 这三个值在界面别处看不到，而填错只会得到一句笼统的拒绝。

   - 页面上有「在这台电脑上生成密钥对」，密钥对在**你的浏览器里**生成，私钥只显示一次、不上传。
   - 也可以在自己的机器上生成，只把公钥贴进去：

     ```bash
     openssl genpkey -algorithm ed25519 -out private.pem
     openssl pkey -in private.pem -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d '='
     ```

3. **控制台 → 短信 → 推送地址**，填一个 HTTPS 地址，`所属项目`选刚才那个接入方，`限定手机`按需要。

**私钥永远不要发给任何人，也不要提交进版本库。** SMS 只保存公钥，无法替你找回私钥——丢了就换一个新 `kid`。

---

## 1. 绑定手机（票据路径）

> 接口尚未上线，协议已定死。

### 1.1 票据长什么样

对一段**固定字段顺序**的 UTF-8 JSON 签名：

```json
{
  "v": 1,
  "aud": "sms",
  "client_id": "shop",
  "kid": "2026-09-01",
  "base_user_id": "<你的账号 id>",
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
| `client_id` | 你的接入方**标识**——控制台「接入方」页那一列，不是「名称」。填错只会得到一句「签名接入方无效」 |
| `kid` | 这张票用哪把私钥签的，SMS 据此找公钥 |
| `base_user_id` | 手机要登记到谁名下。**必须是你自己名下的账号**——你只能给自己注册的账号绑手机，填别人的会得到「目标身份无权绑定手机」 |
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
// 这三个值照抄「公钥已登记」弹窗里报的那三行（见 §0 第 2 步）
$clientId = 'shop';                 // 控制台「接入方」页那一列「标识」
$kid = '2026-09-01';
$baseUserId = '1';                  // 你自己的账号 id

$payload = json_encode([
    'v' => 1,
    'aud' => 'sms',
    'client_id' => $clientId,
    'kid' => $kid,
    'base_user_id' => $baseUserId,
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

// 这三个值照抄「公钥已登记」弹窗里报的那三行（见 §0 第 2 步）
const clientId = 'shop';        // 控制台「接入方」页那一列「标识」
const kid = '2026-09-01';
const baseUserId = '1';         // 你自己的账号 id

const b64url = (buffer) => buffer.toString('base64url');
const payload = JSON.stringify({
  v: 1,
  aud: 'sms',
  client_id: clientId,
  kid,
  base_user_id: baseUserId,
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
  "expires_in": 900,
  "feedback": { "component": "modal", "type": "success", "message": "绑定成功" }
}
```

`already_bound` 为 `true` 表示这个号码之前就在你的项目下绑过了——这时**不会**新建记录，但仍然照常回一个新的下载地址。链接发出去客户没点、15 分钟过期了，**换一张新票据再绑一次同一个号码**就是重新取链接的办法。

### 1.4 失败了怎么办

| HTTP | 提示 | 该怎么处理 |
| --- | --- | --- |
| 400 | 绑定票据格式不正确 / 受众不匹配 / 版本不支持 | 代码问题，照 §1.1 对字段 |
| 400 | 绑定票据已过期或尚未生效 / 有效期过长 | `exp - iat` 不得超过 300 秒；检查机器时钟 |
| 400 | 手机号码格式不正确 | 传 E.164，例如 `+8613800138000` |
| 401 | 签名接入方无效…… | `client_id` 不存在、接入方被停用、这个 `kid` 没登记过或已退役。**`client_id` 是控制台里那一列「标识」，不是「名称」**——照抄本文示例的 `shop` 是最常见的一脚 |
| 401 | 绑定票据签名无效 | 私钥与登记的公钥对不上，或签的字节和发的字节不是同一串 |
| 403 | 这个接入方没有绑定手机的权限 | 到控制台给这个接入方勾上「绑定手机」 |
| 403 | 目标身份无权绑定手机 | `base_user_id` 不存在，或那个账号不是**你名下**的——你只能给自己注册的账号绑 |
| 409 | 绑定票据已使用 | nonce 一次性。**重试要换一张新票据**，不能重发同一张 |
| 503 | 令牌池空了 | 平台侧要补 `.shortcut` 令牌，联系管理员 |

**nonce 一旦消费，票据立刻作废**——即便后面的步骤失败也不退回。这是有意的：宁可让你重签一张，也不能留下「同一张票据还能再绑一次」的口子。所以重试逻辑里请每次都重新生成 `nonce` 与 `iat`/`exp`。

把它交给手机的主人，**在那部手机上打开**下载并添加快捷指令，运行一次即可开始转发。地址 15 分钟内有效，过期可以重新获取。下载下来的文件名是「你的项目名-号码后四位.shortcut」，同一个人收到好几个项目的文件时认得出哪个是哪个。

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
| 验签总是失败 | 先 JSON 解析再重新序列化了。签名的输入是**原始请求体字节** |
| 轮换之后开始失败 | 公钥缓存没有按 `kid` 索引，或者拿到新 `kid` 时没有重新拉 |
| `unknown key id` | 缓存过期时间太长且没有按 `kid` 回源 |
| 同一条短信处理了两次 | 没按 `delivery_id` 去重。重试沿用同一个值 |
| 收不到任何推送 | 推送地址的**所属项目**要与手机登记的项目一致；地址状态是否为「启用」；地址是否 HTTPS |
| 推送地址存不进去 | 必须是 `https://`，且不能指向内网、回环或链路本地地址（服务端每次投递前还会按解析结果再判一次） |

---

## 4. 轮换你的签票密钥

1. 生成一把新密钥对，用**新的 `kid`**（例如今天的日期）登记公钥，状态 `启用中`；
2. 你的服务端切换到新私钥签票；
3. 确认没有在途票据还用旧 `kid`（票据有效期最长 5 分钟，等 5 分钟就够）；
4. 把旧 `kid` 改成 `已退役`——退役之后用它签的票据立即被拒。

`kid` **不重复使用**：一个用过的标识即便记录被删也不该复活，换钥匙就换一个新名字。
