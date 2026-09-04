/**
 * 自定义 ID Token claim：本站账号的凭证 blob。
 *
 * 用带命名空间的 URI 形式，避免和标准 claim 或别的扩展撞名——这是 OIDC 对自定义
 * claim 的通行约定。值就是 `{ hash, pattern }`，与 passport_user_credentials.password
 * 同一形态；两边用的是同一套哈希实现，因此接入方原样存下来就能验通。
 *
 * 这个 claim **不能写进 base_oidc_users.profile**：那一列在「数据管理」里是可见的
 * 普通列，写进去等于又泄一处。
 */
export const CREDENTIAL_CLAIM = 'https://quick-react.dev/claims/credential';
