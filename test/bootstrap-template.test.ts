import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const templatePath = join(
  process.cwd(),
  'bootstrap',
  'roadmap2u-stage-bootstrap.template.json',
);
const operatorTemplatePath = join(process.cwd(), 'bootstrap', 'bootstrap-operator.template.json');
const bootstrapScriptPath = join(process.cwd(), 'scripts', 'aws-bootstrap.ps1');
const breakGlassScriptPath = join(process.cwd(), 'scripts', 'aws-break-glass.ps1');
const smokeCleanupScriptPath = join(process.cwd(), 'scripts', 'aws-smoke-cleanup.ps1');

function runBootstrapWithFakeAws(options: {
  environmentCaBundle: boolean;
  failConfigureLookup: boolean;
}) {
  const fakeDirectory = mkdtempSync(join(tmpdir(), 'roadmap2u-fake-aws-'));
  const windows = process.platform === 'win32';
  const fakeAwsPath = join(fakeDirectory, windows ? 'aws.cmd' : 'aws');
  const fakeAws = windows
    ? `@echo off
if "%~1"=="--version" (
  echo aws-cli/2.36.4 Python/3.13 Windows/11 exe/AMD64
  exit /b 0
)
if "%~1"=="configure" (
  if /I "%FAKE_AWS_FAIL_CONFIG%"=="true" exit /b 9
  exit /b 1
)
if "%~1"=="sts" (
  echo {"UserId":"AIDATEST","Account":"765932874577","Arn":"arn:aws:iam::765932874577:user/Hector-admin"}
  exit /b 0
)
if "%~1"=="cloudformation" exit /b 0
exit /b 2
`
    : `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "aws-cli/2.36.4 Python/3.13 Linux/amd64"
  exit 0
fi
if [[ "$1" == "configure" ]]; then
  [[ "$FAKE_AWS_FAIL_CONFIG" == "true" ]] && exit 9
  exit 1
fi
if [[ "$1" == "sts" ]]; then
  echo '{"UserId":"AIDATEST","Account":"765932874577","Arn":"arn:aws:iam::765932874577:user/Hector-admin"}'
  exit 0
fi
[[ "$1" == "cloudformation" ]] && exit 0
exit 2
`;

  try {
    writeFileSync(fakeAwsPath, fakeAws, 'utf8');
    if (!windows) chmodSync(fakeAwsPath, 0o755);

    const environment = { ...process.env };
    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    environment[pathKey] = `${fakeDirectory}${delimiter}${environment[pathKey] ?? ''}`;
    environment.FAKE_AWS_FAIL_CONFIG = options.failConfigureLookup ? 'true' : 'false';
    if (options.environmentCaBundle) {
      const caBundlePath = join(fakeDirectory, 'trusted-ca.pem');
      writeFileSync(caBundlePath, 'test-ca', 'utf8');
      environment.AWS_CA_BUNDLE = caBundlePath;
    } else {
      delete environment.AWS_CA_BUNDLE;
    }

    const result = spawnSync(windows ? 'powershell.exe' : 'pwsh', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      bootstrapScriptPath,
      '-Phase',
      'create-operator',
      '-AdminProfile',
      'mock-profile',
    ], {
      encoding: 'utf8',
      env: environment,
      timeout: 15_000,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    };
  } finally {
    rmSync(fakeDirectory, { recursive: true, force: true });
  }
}

function runBreakGlassWithFakeAws() {
  const fakeDirectory = mkdtempSync(join(tmpdir(), 'roadmap2u-fake-break-glass-'));
  const windows = process.platform === 'win32';
  const fakeAwsPath = join(fakeDirectory, windows ? 'aws.cmd' : 'aws');
  const caBundlePath = join(fakeDirectory, 'trusted-ca.pem');
  const fakeAws = windows
    ? `@echo off
if "%~1"=="--version" (
  echo aws-cli/2.36.4 Python/3.13 Windows/11 exe/AMD64
  exit /b 0
)
if "%~1"=="configure" (
  echo %FAKE_PROFILE_CA_BUNDLE%
  exit /b 0
)
if "%~1"=="sts" (
  if "%~2"=="assume-role" (
    echo {"AccessKeyId":"ASIATEST","SecretAccessKey":"secret","SessionToken":"token"}
    exit /b 0
  )
  if /I not "%AWS_CA_BUNDLE%"=="%FAKE_PROFILE_CA_BUNDLE%" (
    echo temporary session did not inherit AWS_CA_BUNDLE 1>&2
    exit /b 7
  )
  echo 765932874577
  exit /b 0
)
if "%~1"=="s3api" (
  if "%~2"=="list-object-versions" echo {"Versions":[],"DeleteMarkers":[]}
  exit /b 0
)
if "%~1"=="cloudformation" (
  if "%~2"=="describe-stacks" echo ROLLBACK_COMPLETE
  exit /b 0
)
exit /b 2
`
    : `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "aws-cli/2.36.4 Python/3.13 Linux/amd64"
  exit 0
fi
if [[ "$1" == "configure" ]]; then
  echo "$FAKE_PROFILE_CA_BUNDLE"
  exit 0
fi
if [[ "$1" == "sts" ]]; then
  if [[ "$2" == "assume-role" ]]; then
    echo '{"AccessKeyId":"ASIATEST","SecretAccessKey":"secret","SessionToken":"token"}'
    exit 0
  fi
  if [[ "$AWS_CA_BUNDLE" != "$FAKE_PROFILE_CA_BUNDLE" ]]; then
    echo 'temporary session did not inherit AWS_CA_BUNDLE' >&2
    exit 7
  fi
  echo '765932874577'
  exit 0
fi
if [[ "$1" == "s3api" ]]; then
  [[ "$2" == "list-object-versions" ]] && echo '{"Versions":[],"DeleteMarkers":[]}'
  exit 0
fi
if [[ "$1" == "cloudformation" ]]; then
  [[ "$2" == "describe-stacks" ]] && echo 'ROLLBACK_COMPLETE'
  exit 0
fi
exit 2
`;

  try {
    writeFileSync(fakeAwsPath, fakeAws, 'utf8');
    writeFileSync(caBundlePath, 'test-ca', 'utf8');
    if (!windows) chmodSync(fakeAwsPath, 0o755);

    const environment = { ...process.env };
    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    environment[pathKey] = `${fakeDirectory}${delimiter}${environment[pathKey] ?? ''}`;
    environment.FAKE_PROFILE_CA_BUNDLE = caBundlePath;
    delete environment.AWS_CA_BUNDLE;

    const result = spawnSync(windows ? 'powershell.exe' : 'pwsh', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      breakGlassScriptPath,
      '-Stage',
      'dev',
      '-Confirmation',
      'DESTROY dev',
      '-MfaCode',
      '123456',
      '-AdminProfile',
      'mock-profile',
    ], {
      encoding: 'utf8',
      env: environment,
      timeout: 15_000,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    };
  } finally {
    rmSync(fakeDirectory, { recursive: true, force: true });
  }
}

describe('custom stage CDK bootstrap template', () => {
  it('is versioned and parameterized for the three fixed stage qualifiers', () => {
    expect(existsSync(templatePath)).toBe(true);
    const template = JSON.parse(readFileSync(templatePath, 'utf8'));
    const rendered = JSON.stringify(template);

    expect(template.Parameters.Stage.AllowedValues).toEqual(['dev', 'test', 'prod']);
    expect(template.Parameters.Qualifier.AllowedPattern).toBe('^[a-z0-9]{9}$');
    expect(rendered).toContain('rmap2udev');
    expect(rendered).toContain('rmap2utst');
    expect(rendered).toContain('rmap2uprd');
    expect(rendered).toContain('/cdk-bootstrap/${Qualifier}/version');
  });

  it('trusts only the exact backend role and forbids cross-stage stack deletion', () => {
    expect(existsSync(templatePath)).toBe(true);
    const template = JSON.parse(readFileSync(templatePath, 'utf8'));
    const rendered = JSON.stringify(template);

    expect(rendered).toContain(
      'role/roadmap2u/${Stage}/roadmap2u-${Stage}-backend-deploy',
    );
    expect(rendered).toContain('stack/Roadmap-${Stage}-Backend/*');
    expect(rendered).toContain('stack/Roadmap-${Stage}-Hosting/*');
    expect(rendered).toContain('cloudformation:RoleArn');
    expect(rendered).not.toContain('cloudformation:DeleteStack');
    expect(rendered).not.toContain('stack/Roadmap-*');
    expect(rendered).not.toContain('sts:AssumeRoleWithWebIdentity');
    const changeSetStatement = template.Resources.DeploymentActionRole.Properties.Policies[0]
      .PolicyDocument.Statement.find((statement: any) =>
        Array.isArray(statement.Action)
          ? statement.Action.includes('cloudformation:CreateChangeSet')
          : statement.Action === 'cloudformation:CreateChangeSet',
      );
    expect(changeSetStatement.Condition.StringEquals['cloudformation:RoleArn']).toBeDefined();
    expect(changeSetStatement.Condition.Null).toEqual({
      'cloudformation:ImportResourceTypes': 'true',
    });
    expect(rendered).not.toContain('cloudformation:ChangeSetType');
    const operateStatement = template.Resources.DeploymentActionRole.Properties.Policies[0]
      .PolicyDocument.Statement.find(
        (statement: any) => statement.Sid === 'OperateOnlySelectedStageChangeSets',
      );
    expect(operateStatement.Action).toContain('cloudformation:UpdateTerminationProtection');
  });

  it('attaches only the selected stage core and edge policies to CloudFormation', () => {
    expect(existsSync(templatePath)).toBe(true);
    const template = JSON.parse(readFileSync(templatePath, 'utf8'));
    const rendered = JSON.stringify(template.Resources.CloudFormationExecutionRole);

    expect(rendered).toContain('policy/roadmap2u/${Stage}/roadmap2u-${Stage}-cfn-core');
    expect(rendered).toContain('policy/roadmap2u/${Stage}/roadmap2u-${Stage}-cfn-api');
    expect(rendered).toContain('policy/roadmap2u/${Stage}/roadmap2u-${Stage}-cfn-edge');
    expect(rendered).toContain('policy/roadmap2u/${Stage}/roadmap2u-${Stage}-cfn-data');
    expect(rendered).not.toContain('AdministratorAccess');
  });

  it('owns one stage-named S3 origin access control in each protected toolkit', () => {
    const template = JSON.parse(readFileSync(templatePath, 'utf8'));
    expect(template.Resources.SiteOriginAccessControl).toMatchObject({
      Type: 'AWS::CloudFront::OriginAccessControl',
      Properties: {
        OriginAccessControlConfig: {
          Name: { 'Fn::Sub': 'roadmap2u-${Stage}-s3-oac' },
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        },
      },
    });
    expect(template.Outputs.SiteOriginAccessControlId.Export.Name).toEqual({
      'Fn::Sub': 'RoadMap2U-${Stage}-SiteOacId',
    });
  });

  it.each([
    ['dev', 'rmap2udev', 'RoadMap2U-CDK-dev'],
    ['test', 'rmap2utst', 'RoadMap2U-CDK-test'],
    ['prod', 'rmap2uprd', 'RoadMap2U-CDK-prod'],
  ] as const)('renders an executable fixed %s bootstrap template', (stage, qualifier, stackName) => {
    const path = join(process.cwd(), 'bootstrap', `roadmap2u-${stage}-bootstrap.template.json`);
    expect(existsSync(path)).toBe(true);
    const template = JSON.parse(readFileSync(path, 'utf8'));
    const expected = structuredClone(JSON.parse(readFileSync(templatePath, 'utf8')));
    expected.Parameters.Stage.Default = stage;
    expected.Parameters.Qualifier.Default = qualifier;
    expected.Metadata = {
      ...(expected.Metadata ?? {}),
      RoadMap2U: {
        StackName: stackName,
        Qualifier: qualifier,
        Stage: stage,
        TerminationProtection: true,
      },
    };

    expect(template.Parameters.Stage.Default).toBe(stage);
    expect(template.Parameters.Qualifier.Default).toBe(qualifier);
    expect(template.Metadata.RoadMap2U).toEqual({
      StackName: stackName,
      Qualifier: qualifier,
      Stage: stage,
      TerminationProtection: true,
    });
    expect(JSON.stringify(template)).not.toContain('cloudformation:DeleteStack');
    expect(template).toEqual(expected);
  });

  it('defines a one-hour MFA-only temporary bootstrap operator without OIDC mutation', () => {
    expect(existsSync(operatorTemplatePath)).toBe(true);
    const template = JSON.parse(readFileSync(operatorTemplatePath, 'utf8'));
    const role = template.Resources.BootstrapOperatorRole.Properties;
    const rendered = JSON.stringify(template);

    expect(role.RoleName).toBe('RoadMap2U-BootstrapOperator');
    expect(role.MaxSessionDuration).toBe(3600);
    expect(template.Parameters.HectorAdminPrincipalArn).toEqual({
      Type: 'String',
      Default: 'arn:aws:iam::765932874577:user/Hector-admin',
      AllowedValues: ['arn:aws:iam::765932874577:user/Hector-admin'],
    });
    expect(template.Parameters.HectorAdminRoleArn).toBeUndefined();
    expect(role.AssumeRolePolicyDocument.Statement[0].Principal.AWS).toEqual({
      Ref: 'HectorAdminPrincipalArn',
    });
    expect(rendered).toContain('aws:MultiFactorAuthPresent');
    expect(rendered).toContain('aws:MultiFactorAuthAge');
    expect(rendered).not.toContain('AdministratorAccess');
    expect(rendered).not.toContain('iam:PassRole');
    expect(rendered).not.toMatch(/CreateOpenIDConnectProvider|DeleteOpenIDConnectProvider/);
    expect(rendered).not.toContain('s3:GetBucketEncryption');
    expect(rendered).not.toContain('s3:PutBucketEncryption');
    expect(rendered).toContain('s3:GetEncryptionConfiguration');
    expect(rendered).toContain('s3:PutEncryptionConfiguration');
    expect(template.Outputs.BootstrapOperatorRoleArn).toBeDefined();
  });

  it('lets the operator attach only the twelve stage control-plane policies', () => {
    const template = JSON.parse(readFileSync(operatorTemplatePath, 'utf8'));
    const statements = template.Resources.BootstrapOperatorRole.Properties.Policies[0]
      .PolicyDocument.Statement;
    const attachment = statements.find(
      (statement: any) => statement.Sid === 'AttachOnlyRoadMap2UControlPlanePolicies',
    );

    expect(attachment.Action).toEqual(['iam:AttachRolePolicy', 'iam:DetachRolePolicy']);
    expect(attachment.Resource).toEqual([
      'arn:aws:iam::765932874577:role/roadmap2u/dev/*',
      'arn:aws:iam::765932874577:role/roadmap2u/test/*',
      'arn:aws:iam::765932874577:role/roadmap2u/prod/*',
      'arn:aws:iam::765932874577:role/roadmap2u/operations/*',
      'arn:aws:iam::765932874577:role/cdk-rmap2udev-*',
      'arn:aws:iam::765932874577:role/cdk-rmap2utst-*',
      'arn:aws:iam::765932874577:role/cdk-rmap2uprd-*',
    ]);
    expect(attachment.Condition.ArnEquals['iam:PolicyARN']).toEqual([
      'arn:aws:iam::765932874577:policy/roadmap2u/dev/roadmap2u-dev-cfn-core',
      'arn:aws:iam::765932874577:policy/roadmap2u/dev/roadmap2u-dev-cfn-api',
      'arn:aws:iam::765932874577:policy/roadmap2u/dev/roadmap2u-dev-cfn-data',
      'arn:aws:iam::765932874577:policy/roadmap2u/dev/roadmap2u-dev-cfn-edge',
      'arn:aws:iam::765932874577:policy/roadmap2u/test/roadmap2u-test-cfn-core',
      'arn:aws:iam::765932874577:policy/roadmap2u/test/roadmap2u-test-cfn-api',
      'arn:aws:iam::765932874577:policy/roadmap2u/test/roadmap2u-test-cfn-data',
      'arn:aws:iam::765932874577:policy/roadmap2u/test/roadmap2u-test-cfn-edge',
      'arn:aws:iam::765932874577:policy/roadmap2u/prod/roadmap2u-prod-cfn-core',
      'arn:aws:iam::765932874577:policy/roadmap2u/prod/roadmap2u-prod-cfn-api',
      'arn:aws:iam::765932874577:policy/roadmap2u/prod/roadmap2u-prod-cfn-data',
      'arn:aws:iam::765932874577:policy/roadmap2u/prod/roadmap2u-prod-cfn-edge',
    ]);
    const roleManagement = statements.find(
      (statement: any) => statement.Sid === 'CreateAndManageRoadMap2URoles',
    );
    expect(roleManagement.Resource).not.toContain(
      'arn:aws:iam::765932874577:role/roadmap2u/*',
    );
    expect(JSON.stringify(roleManagement.Resource)).not.toContain('/roadmap2u/bootstrap/');
  });

  it('manages CloudFormation role-name lookups only for the twelve exact control-plane roles', () => {
    const template = JSON.parse(readFileSync(operatorTemplatePath, 'utf8'));
    const statements = template.Resources.BootstrapOperatorRole.Properties.Policies[0]
      .PolicyDocument.Statement;
    const namedRoleManagement = statements.find(
      (statement: any) => statement.Sid === 'ManageOnlyExactRoadMap2URoleNames',
    );

    expect(namedRoleManagement.Action).toEqual([
      'iam:DeleteRole',
      'iam:DeleteRolePolicy',
      'iam:GetRole',
      'iam:GetRolePolicy',
      'iam:ListAttachedRolePolicies',
      'iam:ListRolePolicies',
      'iam:ListRoleTags',
      'iam:PutRolePolicy',
      'iam:TagRole',
      'iam:UntagRole',
      'iam:UpdateAssumeRolePolicy',
      'iam:UpdateRole',
      'iam:UpdateRoleDescription',
    ]);
    expect(namedRoleManagement.Action).not.toContain('iam:CreateRole');
    expect(namedRoleManagement.Resource).toEqual([
      'arn:aws:iam::765932874577:role/roadmap2u-dev-backend-deploy',
      'arn:aws:iam::765932874577:role/roadmap2u-dev-frontend-deploy',
      'arn:aws:iam::765932874577:role/roadmap2u-dev-smoke-cleanup',
      'arn:aws:iam::765932874577:role/roadmap2u-test-backend-deploy',
      'arn:aws:iam::765932874577:role/roadmap2u-test-frontend-deploy',
      'arn:aws:iam::765932874577:role/roadmap2u-test-smoke-cleanup',
      'arn:aws:iam::765932874577:role/roadmap2u-prod-backend-deploy',
      'arn:aws:iam::765932874577:role/roadmap2u-prod-frontend-deploy',
      'arn:aws:iam::765932874577:role/roadmap2u-prod-smoke-cleanup',
      'arn:aws:iam::765932874577:role/roadmap2u-prod-dns-plan',
      'arn:aws:iam::765932874577:role/roadmap2u-prod-dns-cutover',
      'arn:aws:iam::765932874577:role/roadmap2u-nonprod-break-glass',
    ]);

    const pathScopedCreation = statements.find(
      (statement: any) => statement.Sid === 'CreateAndManageRoadMap2URoles',
    );
    expect(pathScopedCreation.Action).toContain('iam:CreateRole');
    expect(pathScopedCreation.Action).toContain('iam:ListRoleTags');
    expect(pathScopedCreation.Resource).not.toEqual(
      expect.arrayContaining(namedRoleManagement.Resource),
    );
  });

  it('allows recovery deletion only for the control-plane stack', () => {
    const template = JSON.parse(readFileSync(operatorTemplatePath, 'utf8'));
    const statements = template.Resources.BootstrapOperatorRole.Properties.Policies[0]
      .PolicyDocument.Statement;
    const recovery = statements.find(
      (statement: any) => statement.Sid === 'RecoverOnlyRoadMap2UControlPlane',
    );

    expect(recovery).toEqual({
      Sid: 'RecoverOnlyRoadMap2UControlPlane',
      Effect: 'Allow',
      Action: 'cloudformation:DeleteStack',
      Resource:
        'arn:aws:cloudformation:us-east-1:765932874577:stack/Roadmap-CiBootstrap/*',
    });
    const ordinaryStackOperations = statements.find(
      (statement: any) => statement.Sid === 'OperateOnlyRoadMap2UBootstrapStacks',
    );
    expect(ordinaryStackOperations.Action).not.toContain('cloudformation:DeleteStack');
  });

  it('stages the large control-plane template in one private temporary bucket prefix', () => {
    const template = JSON.parse(readFileSync(operatorTemplatePath, 'utf8'));
    const bucket = template.Resources.ControlPlaneTemplateBucket.Properties;
    const rendered = JSON.stringify(template);

    expect(bucket.BucketName).toBe('roadmap2u-bootstrap-templates-765932874577-us-east-1');
    expect(bucket.BucketEncryption.ServerSideEncryptionConfiguration[0]
      .ServerSideEncryptionByDefault.SSEAlgorithm).toBe('AES256');
    expect(bucket.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.OwnershipControls.Rules).toEqual([{ ObjectOwnership: 'BucketOwnerEnforced' }]);
    expect(rendered).toContain(
      'arn:aws:s3:::roadmap2u-bootstrap-templates-765932874577-us-east-1/control-plane/*',
    );
    expect(template.Outputs.ControlPlaneTemplateBucketName).toBeDefined();
    const statements = template.Resources.BootstrapOperatorRole.Properties.Policies[0]
      .PolicyDocument.Statement;
    const buckets = statements.find(
      (statement: any) => statement.Sid === 'ManageOnlyRoadMap2UBootstrapBuckets',
    );
    expect(buckets.Action).toEqual(
      expect.arrayContaining([
        's3:GetBucketAcl',
        's3:GetEncryptionConfiguration',
        's3:ListBucket',
      ]),
    );
    const versions = statements.find(
      (statement: any) => statement.Sid === 'ManageOnlyRoadMap2UBootstrapVersions',
    );
    expect(versions.Action).toEqual(
      expect.arrayContaining([
        'ssm:GetParameters',
        'ssm:ListTagsForResource',
        'ssm:RemoveTagsFromResource',
      ]),
    );
  });

  it('lets only the temporary operator install and maintain toolkit OACs', () => {
    const template = JSON.parse(readFileSync(operatorTemplatePath, 'utf8'));
    const statements = template.Resources.BootstrapOperatorRole.Properties.Policies[0]
      .PolicyDocument.Statement;
    const create = statements.find(
      (statement: any) => statement.Sid === 'CreateToolkitOriginAccessControls',
    );
    const manage = statements.find(
      (statement: any) => statement.Sid === 'ManageToolkitOriginAccessControls',
    );

    expect(create).toMatchObject({
      Action: 'cloudfront:CreateOriginAccessControl',
      Resource: '*',
    });
    expect(manage.Action).toEqual([
      'cloudfront:DeleteOriginAccessControl',
      'cloudfront:GetOriginAccessControl',
      'cloudfront:UpdateOriginAccessControl',
    ]);
    expect(JSON.stringify(manage.Action)).not.toContain('GetOriginAccessControlConfig');
    expect(manage.Resource).toBe(
      'arn:aws:cloudfront::765932874577:origin-access-control/*',
    );
    expect(JSON.stringify(statements)).not.toContain('ResponseHeadersPolicy');
  });

  it('provides executable AWS CLI phases for control-plane synth, stage bootstrap, and cleanup', () => {
    expect(existsSync(bootstrapScriptPath)).toBe(true);
    const script = readFileSync(bootstrapScriptPath, 'utf8');

    expect(script).toContain("'create-operator'");
    expect(script).toContain("'deploy-control-plane'");
    expect(script).toContain("'deploy-stage-toolkits'");
    expect(script).toContain("'deploy-all'");
    expect(script).toContain("'delete-operator'");
    expect(script).toContain('cloudformation deploy');
    expect(script).toContain('update-termination-protection');
    expect(script).toContain('Roadmap-CiBootstrap');
    expect(script).toContain('RoadMap2U-CDK-dev');
    expect(script).toContain('RoadMap2U-CDK-test');
    expect(script).toContain('RoadMap2U-CDK-prod');
    expect(script).toContain('cdk synth');
    expect(script).toContain(
      "[string]$HectorAdminPrincipalArn = 'arn:aws:iam::765932874577:user/Hector-admin'",
    );
    expect(script).toContain('"HectorAdminPrincipalArn=$HectorAdminPrincipalArn"');
    expect(script).not.toContain('role/Hector-admin');
    expect(script).toContain("Join-Path $env:LOCALAPPDATA 'Programs\\Amazon\\AWSCLIV2\\aws.exe'");
    expect(script).toContain("-notmatch '^aws-cli/2\\.'");
    expect(script).toContain('configure get ca_bundle');
    expect(script).toContain('--profile $AdminProfile');
    expect(script).toContain('$effectiveCaBundle = $env:AWS_CA_BUNDLE');
    expect(script).toContain('$profileCaBundleExitCode -notin @(0, 1)');
    expect(script).toContain('Test-Path -LiteralPath $effectiveCaBundle -PathType Leaf');
    expect(script).toContain('(Resolve-Path -LiteralPath $effectiveCaBundle).Path');
    expect(script).toContain('CaBundle = $env:AWS_CA_BUNDLE');
    expect(script).toContain('$env:AWS_CA_BUNDLE = $effectiveCaBundle');
    expect(script).toContain('$env:AWS_CA_BUNDLE = $Previous.CaBundle');
    expect(script).toContain('--s3-bucket $controlPlaneBucket');
    expect(script).toContain("--s3-prefix 'control-plane'");
    expect(script).toContain('s3://$controlPlaneBucket/control-plane/');
    expect(script).toContain('--recursive');
    expect(script).toContain("$Phase -in @('deploy-control-plane', 'deploy-all')");
    expect(script).toContain("$Phase -in @('deploy-stage-toolkits', 'deploy-all')");
    expect(script).toContain('get-open-id-connect-provider');
    expect(script).toContain(
      'arn:aws:iam::$AccountId`:oidc-provider/token.actions.githubusercontent.com',
    );
    expect(script).toContain("$provider.Url -ne 'token.actions.githubusercontent.com'");
    expect(script).toContain("$provider.ClientIDList -notcontains 'sts.amazonaws.com'");
    expect(script).toContain('@($provider.ClientIDList).Count -ne 1');
    expect(script).toContain('Assert-GitHubOidcProvider');
    expect(script.indexOf('Assert-GitHubOidcProvider')).toBeLessThan(
      script.lastIndexOf('Enter-BootstrapOperatorSession'),
    );
    expect(script).toContain("$AccountId -cne '765932874577'");
    expect(script).toContain("$Region -cne 'us-east-1'");
    expect(script).toContain("$HostedZoneId -cne 'Z08619612LYY2MSBEZSCQ'");
    expect(script).toContain(
      "$HectorAdminPrincipalArn -cne 'arn:aws:iam::765932874577:user/Hector-admin'",
    );
    expect(script).toContain(
      "$HectorMfaArn -cne 'arn:aws:iam::765932874577:mfa/HectorPhone'",
    );
    expect(script).toContain('sts get-caller-identity');
    expect(script).toContain('$caller.Account -cne $AccountId');
    expect(script).toContain('$caller.Arn -cne $HectorAdminPrincipalArn');
    expect(script.indexOf('sts get-caller-identity')).toBeLessThan(
      script.indexOf("if ($Phase -eq 'create-operator')"),
    );
    expect(script).toContain("$recoverableControlPlaneStates = @('ROLLBACK_COMPLETE', 'ROLLBACK_FAILED')");
    expect(script.match(/Remove-FailedControlPlaneStack/g)).toHaveLength(2);
    expect(script).toContain('--stack-status-filter $recoverableControlPlaneStates');
    expect(script).toContain("--stack-name 'Roadmap-CiBootstrap'");
    expect(script.lastIndexOf('Remove-FailedControlPlaneStack')).toBeLessThan(
      script.indexOf("Assert-LastCommand 'Deploying Roadmap-CiBootstrap directly with CloudFormation'"),
    );
  });

  it(
    'accepts an AWS profile that does not configure a custom CA bundle',
    () => {
      const result = runBootstrapWithFakeAws({
        environmentCaBundle: false,
        failConfigureLookup: false,
      });

      expect(result).toMatchObject({ status: 0, error: undefined });
    },
    20_000,
  );

  it(
    'keeps AWS_CA_BUNDLE precedence instead of reading a lower-priority profile value',
    () => {
      const result = runBootstrapWithFakeAws({
        environmentCaBundle: true,
        failConfigureLookup: true,
      });

      expect(result).toMatchObject({ status: 0, error: undefined });
    },
    20_000,
  );

  it('provides a resumable MFA-only non-production destroy script that empties every object version first', () => {
    expect(existsSync(breakGlassScriptPath)).toBe(true);
    const script = readFileSync(breakGlassScriptPath, 'utf8');

    expect(script).toContain("[ValidateSet('dev', 'test')]");
    expect(script).not.toContain("[ValidateSet('dev', 'test', 'prod')]");
    expect(script).toContain('roadmap2u-nonprod-break-glass');
    expect(script).toContain('head-bucket');
    expect(script).toContain('list-object-versions');
    expect(script).toContain('--max-keys 1000');
    expect(script).toContain('delete-objects');
    expect(script).toContain('VersionId');
    expect(script).toContain('$null -ne $response.Errors');
    expect(script).toContain('Test-StackExists');
    expect(script).toContain('does not exist');
    expect(script).toContain('Roadmap-$Stage-Hosting');
    expect(script).toContain('Roadmap-$Stage-Backend');
    expect(script.indexOf('list-object-versions')).toBeLessThan(script.indexOf('delete-stack'));
    expect(script).toContain('--serial-number $HectorMfaArn');
    expect(script).toContain('AWS CLI v2 was not found in PATH and LOCALAPPDATA is unavailable.');
    expect(script).not.toContain('Roadmap-prod-');
  });

  it(
    'propagates the profile CA bundle into the break-glass temporary session',
    () => {
      const result = runBreakGlassWithFakeAws();

      expect(result, JSON.stringify(result)).toMatchObject({ status: 0, error: undefined });
    },
    20_000,
  );

  it('provides a stage-checked MFA smoke cleanup with paginated delete-only DynamoDB access', () => {
    expect(existsSync(smokeCleanupScriptPath)).toBe(true);
    const script = readFileSync(smokeCleanupScriptPath, 'utf8');

    expect(script).toContain("[ValidateSet('dev', 'test', 'prod')]");
    expect(script).toContain("[ValidatePattern('^smoke_[a-z0-9_]{1,14}$')]");
    expect(script).toContain('roadmap2u-$Stage-smoke-cleanup');
    expect(script).toContain('--serial-number $HectorMfaArn');
    expect(script).toContain('$effectiveCaBundle = $env:AWS_CA_BUNDLE');
    expect(script).toContain('configure get ca_bundle --profile $AdminProfile');
    expect(script).toContain('CaBundle = $env:AWS_CA_BUNDLE');
    expect(script).toContain('$env:AWS_CA_BUNDLE = $effectiveCaBundle');
    expect(script).toContain('$env:AWS_CA_BUNDLE = $previous.CaBundle');
    expect(script).toContain('/roadmap2u/$Stage/user-pool-id');
    expect(script).toContain('admin-get-user');
    expect(script).toContain('admin-delete-user');
    expect(script).toContain("USER#$UserId");
    expect(script).toContain("UNIQ#USERNAME#$($Username.ToLowerInvariant())");
    expect(script).toContain(
      "--condition-expression 'attribute_not_exists(#pk) OR #uid = :expectedUserId'",
    );
    expect(script).toContain("@{ '#pk' = 'pk'; '#uid' = 'userId' }");
    expect(script).toContain("':expectedUserId' = @{ S = $UserId }");
    expect(script).toContain('--exclusive-start-key');
    expect(script).toContain('dynamodb delete-item');
    expect(script).not.toContain('batch-write-item');
    expect(script).not.toContain('PutRequest');
    expect(script).not.toContain('-Encoding utf8');
    expect(script).toContain('-Encoding ascii');
    expect(script).toContain("DELETE SMOKE $Stage $Username");
    expect(script.indexOf('admin-get-user')).toBeLessThan(script.indexOf('admin-delete-user'));
    expect(script.lastIndexOf('Remove-UserPartitionItems')).toBeLessThan(
      script.indexOf('admin-delete-user'),
    );
  });
});
