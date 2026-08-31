import type { ApiHandler } from '@server/modules/base/api-router.mjs';
import { apiResponse } from '@server/modules/base/api-response.mjs';

const handler: ApiHandler = (c) => apiResponse(c, 200, {
	dashboard: {
		recentTitle: '',
		statistics: [],
		recentColumns: [],
		recentRows: [],
	},
});

export default handler;
