import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiMessage, apiResponse } from '@server/modules/base/api-response.mjs';
import { ensureSigningKey } from '@server/modules/passport/accounts/oidc.mjs';
import { signingPublicKeys } from '@server/modules/passport/accounts/repository.mjs';

const handler: ApiHandler = async (c) => {
	if (c.req.method !== 'GET') return apiMessage(c, 404);
	// OIDC 协议端点是机器对机器的匿名请求，没有用户会话，必须走未绑定主体的适配器。
	const database = c.get('systemPassportDatabase'); if (!database) return apiMessage(c, 503);
	await ensureSigningKey(database);
	const rows = await signingPublicKeys(database);
	return apiResponse(c, 200, { keys: rows.map((row) => JSON.parse(row.public_jwk)) });
};
export default handler;
