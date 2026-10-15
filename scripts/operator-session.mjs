import { buildOperatorProfiles, createOperatorSessionProvider } from './lib/operator-session.mjs';

const mode = process.argv[2] ?? 'status';
const stage = process.argv[3] ?? 'dev';
try {
  if (!['start', 'status'].includes(mode) || !['dev', 'test', 'prod', 'all'].includes(stage) || process.argv.length > 4) {
    throw new Error('UseOperatorSessionStartOrStatusWithAnExactStage');
  }
  const load = createOperatorSessionProvider(); const evidence = [];
  for (const profile of buildOperatorProfiles().filter(p => stage === 'all' || p.stage === stage)) {
    const first = await load(profile.stage, profile.purpose);
    const second = await load(profile.stage, profile.purpose);
    if (first.raw.AccessKeyId !== second.raw.AccessKeyId || first.expiration !== second.expiration) {
      throw new Error('OperatorSessionCacheWasNotReused');
    }
    evidence.push({ ...first, cacheReused: true });
  }
  console.log(JSON.stringify({ status: 'ready', requestedStage: stage, sessions: evidence }));
} catch (error) {
  const code = /^[A-Za-z][A-Za-z0-9]{1,100}$/.test(error?.message ?? '') ? error.message : 'OperatorSessionUnavailable';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
}
