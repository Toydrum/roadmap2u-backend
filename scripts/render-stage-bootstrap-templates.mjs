import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'bootstrap', 'roadmap2u-stage-bootstrap.template.json');
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const stages = {
  dev: { qualifier: 'rmap2udev', stackName: 'RoadMap2U-CDK-dev' },
  test: { qualifier: 'rmap2utst', stackName: 'RoadMap2U-CDK-test' },
  prod: { qualifier: 'rmap2uprd', stackName: 'RoadMap2U-CDK-prod' },
};

for (const [stage, config] of Object.entries(stages)) {
  const template = structuredClone(source);
  template.Parameters.Stage.Default = stage;
  template.Parameters.Qualifier.Default = config.qualifier;
  template.Metadata = {
    ...(template.Metadata ?? {}),
    RoadMap2U: {
      StackName: config.stackName,
      Qualifier: config.qualifier,
      Stage: stage,
      TerminationProtection: true,
    },
  };
  const destination = join(root, 'bootstrap', `roadmap2u-${stage}-bootstrap.template.json`);
  writeFileSync(destination, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
}
