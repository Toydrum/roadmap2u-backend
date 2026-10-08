import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Resolve enum-only CloudFormation arguments against the actual current stack. */
export function resolvePrivacyDeployment({
  stage,
  operation,
  adult = 'keep',
  adolescent = 'keep',
  releaseTemplate,
  currentStack,
}) {
  if (!['dev', 'test', 'prod'].includes(stage))
    throw new Error('Invalid privacy deployment stage.');
  if (!['deploy', 'promote', 'rollback'].includes(operation))
    throw new Error('Invalid privacy deployment operation.');
  for (const mode of [adult, adolescent]) {
    if (!['keep', 'off', 'enforce'].includes(mode))
      throw new Error('Invalid explicit privacy mode.');
  }
  if (operation === 'rollback' && (adult !== 'keep' || adolescent !== 'keep'))
    throw new Error(
      'A rollback must preserve privacy modes; activation is a separate release operation.',
    );
  const names = ['AdultPrivacyMode', 'PrivateAdolescentMode'];
  const previous = names.map((name) =>
    (currentStack?.Parameters ?? []).filter((p) => p.ParameterKey === name),
  );
  if (
    previous.some((entries) => entries.length > 1) ||
    previous.filter((entries) => entries.length).length === 1
  )
    throw new Error('Current privacy parameters are incomplete or duplicated.');
  const current = previous.map((entries) => entries[0]?.ParameterValue ?? 'off');
  if (current.some((mode) => !['off', 'enforce'].includes(mode)))
    throw new Error('Invalid current privacy mode.');
  const supported = names.every((name) => {
    const values = releaseTemplate?.Parameters?.[name]?.AllowedValues;
    return (
      Array.isArray(values) &&
      values.length === 2 &&
      values.includes('off') &&
      values.includes('enforce')
    );
  });
  if (!supported && (previous[0].length > 0 || adult !== 'keep' || adolescent !== 'keep'))
    throw new Error('Refusing a release without privacy controls after privacy installation.');
  const expected = {
    adult: adult === 'keep' ? current[0] : adult,
    adolescent: adolescent === 'keep' ? current[1] : adolescent,
  };
  if (expected.adolescent === 'enforce' && expected.adult !== 'enforce')
    throw new Error('Private adolescents require adult privacy enforcement.');
  const parameters = [];
  for (const [name, mode] of [
    [names[0], adult],
    [names[1], adolescent],
  ]) {
    if (mode !== 'keep')
      parameters.push('--parameters', `Roadmap-${stage}-Backend:${name}=${mode}`);
  }
  return { supported, expected, parameters };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
    const result = resolvePrivacyDeployment({
      stage: process.env.STAGE,
      operation: process.env.OPERATION,
      adult: process.env.ADULT_PRIVACY_MODE ?? 'keep',
      adolescent: process.env.PRIVATE_ADOLESCENT_MODE ?? 'keep',
      releaseTemplate: readJson(`cdk.out/Roadmap-${process.env.STAGE}-Backend.template.json`),
      currentStack: readJson('current-privacy-parameters.json'),
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
