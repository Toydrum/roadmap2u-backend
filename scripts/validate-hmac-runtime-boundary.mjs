import { pathToFileURL } from 'node:url';

const MODES = new Set(['ssm', 'secrets-manager']);
const EXPECTED_SECRET_ACTIONS = [
  'secretsmanager:describesecret',
  'secretsmanager:getsecretvalue',
];

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function list(value, label) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  return values;
}

function normalizedActions(statement) {
  if (Object.hasOwn(statement, 'NotAction')) throw new Error('NotAction is forbidden');
  if (!Object.hasOwn(statement, 'Action')) throw new Error('Action is required');
  return list(statement.Action, 'Action').map((action) => {
    if (typeof action !== 'string' || action.length === 0) {
      throw new Error('Action must contain non-empty strings');
    }
    return action.toLowerCase();
  });
}

function exactStrings(actual, expected) {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

function exactResource(statement, expectedResource) {
  if (Object.hasOwn(statement, 'NotResource')) return false;
  if (!Object.hasOwn(statement, 'Resource')) return false;
  const resources = list(statement.Resource, 'Resource');
  return resources.length === 1 && resources[0] === expectedResource;
}

function exactStatement(statement, { actions, resource, sid }) {
  return (
    statement.Sid === sid &&
    !Object.hasOwn(statement, 'Condition') &&
    exactStrings(normalizedActions(statement), actions) &&
    exactResource(statement, resource)
  );
}

export function validateHmacRuntimeBoundary({
  mode,
  parameterResource,
  policyDocument,
  retainedSecretResource,
}) {
  if (!MODES.has(mode)) throw new Error('mode must be ssm or secrets-manager');
  if (!isRecord(policyDocument)) throw new Error('Policy document must be an object');
  const hasRetainedSecret = retainedSecretResource !== undefined;
  if (hasRetainedSecret && (typeof retainedSecretResource !== 'string' || retainedSecretResource.length === 0)) {
    throw new Error('retainedSecretResource must be a non-empty string when provided');
  }
  if (mode === 'secrets-manager' && !hasRetainedSecret) {
    throw new Error('retainedSecretResource is required in secrets-manager mode');
  }
  if (mode === 'ssm' && (typeof parameterResource !== 'string' || parameterResource.length === 0)) {
    throw new Error('parameterResource is required in ssm mode');
  }

  const statements = list(policyDocument.Statement, 'Statement').map((statement) => {
    if (!isRecord(statement)) throw new Error('Every Statement must be an object');
    return statement;
  });
  const inspected = statements
    .filter((statement) => statement.Effect === 'Allow' || statement.Effect === 'Deny')
    .map((statement) => ({ statement, actions: normalizedActions(statement) }));

  const wildcardAllows = inspected.filter(
    ({ statement, actions }) =>
      statement.Effect === 'Allow' &&
      actions.some((action) => action.includes('*') || action.includes('?')),
  );
  if (wildcardAllows.length !== 0) throw new Error('Action wildcards are forbidden');

  const relevantDenies = inspected.filter(
    ({ statement, actions }) =>
      statement.Effect === 'Deny' &&
      actions.some(
        (action) =>
          action.startsWith('ssm:') ||
          action.startsWith('secretsmanager:') ||
          action.includes('*') ||
          action.includes('?'),
      ),
  );
  if (relevantDenies.length !== 0) throw new Error('Relevant Deny statements are forbidden');

  const ssmAllows = inspected.filter(
    ({ statement, actions }) =>
      statement.Effect === 'Allow' && actions.some((action) => action.startsWith('ssm:')),
  );
  const secretAllows = inspected.filter(
    ({ statement, actions }) =>
      statement.Effect === 'Allow' &&
      actions.some((action) => action.startsWith('secretsmanager:')),
  );

  const expectedSsmCount = mode === 'ssm' ? 1 : 0;
  if (ssmAllows.length !== expectedSsmCount) {
    throw new Error(`Expected ${expectedSsmCount} SSM allow statement(s)`);
  }
  if (mode === 'ssm') {
    const [ssmAllow] = ssmAllows;
    if (
      !exactStatement(ssmAllow.statement, {
        actions: ['ssm:getparameter'],
        resource: parameterResource,
        sid: 'ReadOnlySponsoredAccessHmacParameter',
      })
    ) {
      throw new Error('SSM HMAC statement does not match the exact expected authority');
    }
  }

  const expectedSecretCount = hasRetainedSecret ? 1 : 0;
  if (secretAllows.length !== expectedSecretCount) {
    throw new Error(`Expected ${expectedSecretCount} Secrets Manager allow statement(s)`);
  }
  if (hasRetainedSecret) {
    const [secretAllow] = secretAllows;
    if (
      !exactStatement(secretAllow.statement, {
        actions: EXPECTED_SECRET_ACTIONS,
        resource: retainedSecretResource,
        sid: 'ReadOnlyRetainedSponsoredAccessHmacSecretDuringMigration',
      })
    ) {
      throw new Error('Secrets Manager HMAC statement does not match the exact expected authority');
    }
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (typeof option !== 'string' || !option.startsWith('--') || typeof value !== 'string') {
      throw new Error('Options must use --name value syntax');
    }
    const name = option.slice(2);
    if (!['mode', 'parameter-resource', 'retained-secret-resource'].includes(name)) {
      throw new Error(`Unknown option --${name}`);
    }
    if (values.has(name)) throw new Error(`Duplicate option --${name}`);
    values.set(name, value);
  }
  return {
    mode: values.get('mode'),
    parameterResource: values.get('parameter-resource'),
    retainedSecretResource: values.get('retained-secret-resource'),
  };
}

async function readStandardInput(input) {
  let contents = '';
  for await (const chunk of input) contents += chunk.toString('utf8');
  if (contents.trim().length === 0) throw new Error('Policy document JSON is required on stdin');
  return contents;
}

export async function main({ argv = process.argv.slice(2), input = process.stdin } = {}) {
  const options = parseArguments(argv);
  const policyDocument = JSON.parse(await readStandardInput(input));
  validateHmacRuntimeBoundary({ ...options, policyDocument });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
