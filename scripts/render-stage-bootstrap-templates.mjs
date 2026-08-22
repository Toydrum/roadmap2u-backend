import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'bootstrap', 'roadmap2u-stage-bootstrap.template.json');
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const operatorPath = join(root, 'bootstrap', 'bootstrap-operator.template.json');
const operator = JSON.parse(readFileSync(operatorPath, 'utf8'));
const stages = {
  dev: { qualifier: 'rmap2udev', stackName: 'RoadMap2U-CDK-dev' },
  test: { qualifier: 'rmap2utst', stackName: 'RoadMap2U-CDK-test' },
  prod: { qualifier: 'rmap2uprd', stackName: 'RoadMap2U-CDK-prod' },
};

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sourceTemplateSha256 = createHash('sha256')
  .update(canonicalJson(source), 'utf8')
  .digest('hex');

for (const [stage, config] of Object.entries(stages)) {
  const template = structuredClone(source);
  template.Parameters.Stage.Default = stage;
  template.Parameters.Qualifier.Default = config.qualifier;
  template.Metadata = {
    ...(template.Metadata ?? {}),
    RoadMap2U: {
      ...(template.Metadata?.RoadMap2U ?? {}),
      StackName: config.stackName,
      Qualifier: config.qualifier,
      Stage: stage,
      TerminationProtection: true,
      SourceTemplateSha256: sourceTemplateSha256,
    },
  };
  const destination = join(root, 'bootstrap', `roadmap2u-${stage}-bootstrap.template.json`);
  writeFileSync(destination, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
}

operator.Metadata = {
  ...(operator.Metadata ?? {}),
  RoadMap2U: {
    ControlPlaneContractVersion: 34,
    StageBootstrapTemplateSha256: sourceTemplateSha256,
    RequiredControlPlaneOutputs: [
      'devInventoryRuntimeBoundaryArn',
      'testInventoryRuntimeBoundaryArn',
      'prodInventoryRuntimeBoundaryArn',
    ],
  },
};
writeFileSync(operatorPath, `${JSON.stringify(operator, null, 2)}\n`, 'utf8');
