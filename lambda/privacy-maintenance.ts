import { realDeps } from './db';
import { instrumentHandler } from './observability';
import { maintainPrivacy } from './privacy/maintenance';
export const handler = instrumentHandler('privacy-maintenance', async () => {
  const auditTable = process.env['AUDIT_TABLE_NAME'];
  if (!auditTable) throw new Error('AUDIT_TABLE_NAME is required');
  const result = await maintainPrivacy({ ...realDeps(), auditTable });
  if (result.failures)
    throw new Error(`privacy maintenance requires retry (${result.failures} operations)`);
  return result;
});
