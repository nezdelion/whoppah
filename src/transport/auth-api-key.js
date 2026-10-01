// Authorization by the X-Api-Key header (standalone mode).
// Auth contract: init(http), prepare(request), recover(error, attempt), describe(error); optional ready().
import { t } from '../i18n/index.js';

export function createApiKeyAuth({ getKey }) {
  return {
    ready: () => !!getKey(),
    async init() {},
    async prepare(request) {
      return { ...request, headers: { ...request.headers, 'X-Api-Key': getKey() } };
    },
    async recover() { return 'fail'; },
    describe(error) {
      if (error.status === 401 || error.status === 403) return t('auth.keyRejected', { status: error.status });
      return null;
    },
  };
}
