import { Arn, Aws, CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties, CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD_POLICY } from '@app/auth/auth-types';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_DOMAIN = 'roadmap2u.com';
const CONTRACT_FILES = ['api/contracts.ts', 'db/schema.ts', 'auth/auth-types.ts'] as const;

export type DeploymentStage = 'dev' | 'test' | 'prod';

const STAGE_BOOTSTRAP_QUALIFIERS: Record<DeploymentStage, string> = {
  dev: 'rmap2udev',
  test: 'rmap2utst',
  prod: 'rmap2uprd',
};

export interface RoadmapStackProps extends StackProps {
  readonly stage: DeploymentStage;
  readonly hostedZoneId: string;
  readonly contractHash?: string;
}

export interface RoadmapHostingStackProps extends StackProps {
  readonly stage: DeploymentStage;
  readonly hostedZoneId: string;
}

export interface RoadmapCiBootstrapStackProps extends StackProps {
  readonly hostedZoneId: string;
  readonly githubOwner: string;
  readonly backendRepository: string;
  readonly frontendRepository: string;
}

export function assertDeploymentStage(value: string): asserts value is DeploymentStage {
  if (!['dev', 'test', 'prod'].includes(value)) {
    throw new Error(`Invalid stage "${value}". Expected one of: dev, test, prod.`);
  }
}

export function bootstrapQualifierFor(stage: DeploymentStage): string {
  assertDeploymentStage(stage);
  return STAGE_BOOTSTRAP_QUALIFIERS[stage];
}

export function calculateContractHash(): string {
  const hash = createHash('sha256');
  for (const relativePath of CONTRACT_FILES) {
    hash.update(relativePath, 'utf8');
    hash.update('\0');
    const contents = readFileSync(join(here, '..', 'shared', relativePath), 'utf8').replaceAll(
      '\r\n',
      '\n',
    );
    hash.update(contents, 'utf8');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function apiDomainFor(stage: DeploymentStage): string {
  return stage === 'prod' ? `api.${ROOT_DOMAIN}` : `api.${stage}.${ROOT_DOMAIN}`;
}

function frontendDomainFor(stage: DeploymentStage): string {
  return stage === 'prod' ? ROOT_DOMAIN : `${stage}.${ROOT_DOMAIN}`;
}

function corsOriginsFor(stage: DeploymentStage): string[] {
  const deployedOrigin = `https://${frontendDomainFor(stage)}`;
  return stage === 'prod'
    ? [deployedOrigin]
    : [deployedOrigin, 'http://localhost:4200', 'http://localhost:8826'];
}

export function cloudFrontRequestRouterCode(stage: DeploymentStage): string {
  assertDeploymentStage(stage);
  const redirect =
    stage === 'prod'
      ? `if(host==='www.${ROOT_DOMAIN}'){return {statusCode:301,statusDescription:'Moved Permanently',headers:{location:{value:'https://${ROOT_DOMAIN}'+request.uri+querySuffix(request.querystring)}}};}`
      : '';
  return `function querySuffix(query){var parts=[];for(var key in query){var item=query[key];var values=item.multiValue||[item];for(var i=0;i<values.length;i++){parts.push(encodeURIComponent(key)+'='+encodeURIComponent(values[i].value||''));}}return parts.length?'?'+parts.join('&'):'';}function handler(event){var request=event.request;var host=request.headers.host?request.headers.host.value:'';${redirect}var uri=request.uri;var leaf=uri.substring(uri.lastIndexOf('/')+1);if(uri==='/'||uri.endsWith('/')||leaf.indexOf('.')===-1){request.uri='/index.html';}return request;}`;
}

/** Backend resources for one explicitly selected deployment stage. */
export class RoadmapStack extends Stack {
  constructor(scope: Construct, id: string, props: RoadmapStackProps) {
    super(scope, id, props);

    const { stage, hostedZoneId } = props;
    assertDeploymentStage(stage);
    if (props.env?.region && props.env.region !== 'us-east-1') {
      throw new Error('RoadMap2U infrastructure must be deployed in us-east-1.');
    }

    const production = stage === 'prod';
    const removalPolicy = production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const apiDomain = apiDomainFor(stage);
    const parameterPrefix = `/roadmap2u/${stage}`;
    const contractHash = props.contractHash ?? calculateContractHash();
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId,
      zoneName: ROOT_DOMAIN,
    });

    const preSignUp = new NodejsFunction(this, 'PreSignUp', {
      functionName: `roadmap-pre-signup-${stage}`,
      entry: join(here, '../lambda/pre-signup.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      bundling: {
        format: OutputFormat.ESM,
        tsconfig: join(here, '../tsconfig.json'),
        target: 'node22',
      },
    });

    const postConfirmation = new NodejsFunction(this, 'PostConfirmation', {
      functionName: `roadmap-post-confirmation-${stage}`,
      entry: join(here, '../lambda/post-confirmation.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      bundling: {
        format: OutputFormat.ESM,
        tsconfig: join(here, '../tsconfig.json'),
        target: 'node22',
      },
    });

    const pool = new cognito.UserPool(this, 'Users', {
      userPoolName: `roadmap-users-${stage}`,
      selfSignUpEnabled: true,
      signInAliases: { username: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: false, mutable: true },
        fullname: { required: false, mutable: true },
      },
      customAttributes: {
        accountType: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: PASSWORD_POLICY.minLength,
        requireLowercase: PASSWORD_POLICY.requireLower,
        requireUppercase: PASSWORD_POLICY.requireUpper,
        requireDigits: PASSWORD_POLICY.requireDigit,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      userVerification: { emailStyle: cognito.VerificationEmailStyle.CODE },
      deletionProtection: production,
      removalPolicy,
      lambdaTriggers: { preSignUp, postConfirmation },
    });
    Tags.of(pool).add('roadmap2u-project', 'RoadMap2U');
    Tags.of(pool).add('roadmap2u-stage', stage);

    const webClient = pool.addClient('Web', {
      userPoolClientName: `roadmap-web-${stage}`,
      generateSecret: false,
      authFlows: { userSrp: true },
      disableOAuth: true,
      preventUserExistenceErrors: true,
      refreshTokenValidity: Duration.days(30),
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
        fullname: true,
      }),
    });

    const table = new dynamodb.Table(this, 'Table', {
      tableName: `roadmap-${stage}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: production },
      deletionProtection: production,
      removalPolicy,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });
    table.addGlobalSecondaryIndex({
      indexName: 'gsi2',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
    });

    postConfirmation.addEnvironment('TABLE_NAME', table.tableName);
    table.grantWriteData(postConfirmation);
    postConfirmation.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminUpdateUserAttributes'],
        // Avoid a UserPool -> Lambda -> IAM policy -> UserPool dependency cycle.
        resources: [
          Arn.format(
            {
              partition: Aws.PARTITION,
              service: 'cognito-idp',
              region: this.region,
              account: this.account,
              resource: 'userpool',
              resourceName: '*',
            },
            this,
          ),
        ],
        conditions: {
          StringEquals: {
            'aws:ResourceTag/roadmap2u-project': 'RoadMap2U',
            'aws:ResourceTag/roadmap2u-stage': stage,
          },
        },
      }),
    );

    const router = new NodejsFunction(this, 'Router', {
      functionName: `roadmap-router-${stage}`,
      entry: join(here, '../lambda/router.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(15),
      environment: { TABLE_NAME: table.tableName, USER_POOL_ID: pool.userPoolId },
      bundling: {
        format: OutputFormat.ESM,
        tsconfig: join(here, '../tsconfig.json'),
        target: 'node22',
      },
    });
    table.grantReadWriteData(router);
    router.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminDeleteUser',
        ],
        resources: [pool.userPoolArn],
      }),
    );

    const apiCertificate = new certificatemanager.Certificate(this, 'ApiCertificate', {
      domainName: apiDomain,
      validation: certificatemanager.CertificateValidation.fromDns(zone),
    });
    Tags.of(apiCertificate).add('roadmap2u-project', 'RoadMap2U');
    Tags.of(apiCertificate).add('roadmap2u-stage', stage);
    const customDomain = new apigatewayv2.DomainName(this, 'ApiDomain', {
      domainName: apiDomain,
      certificate: apiCertificate,
      securityPolicy: apigatewayv2.SecurityPolicy.TLS_1_2,
    });
    const api = new apigatewayv2.HttpApi(this, 'Api', {
      apiName: `roadmap-api-${stage}`,
      defaultDomainMapping: { domainName: customDomain },
      corsPreflight: {
        allowOrigins: corsOriginsFor(stage),
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PATCH,
          apigatewayv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.days(1),
      },
    });
    const authorizer = new HttpJwtAuthorizer(
      'CognitoJwt',
      `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`,
      { jwtAudience: [webClient.userPoolClientId] },
    );
    api.addRoutes({
      path: '/v1/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: new HttpLambdaIntegration('RouterIntegration', router),
      authorizer,
    });

    const apiAlias = route53.RecordTarget.fromAlias(
      new ApiGatewayv2DomainProperties(
        customDomain.regionalDomainName,
        customDomain.regionalHostedZoneId,
      ),
    );
    new route53.ARecord(this, 'ApiAliasA', { zone, recordName: apiDomain, target: apiAlias });
    new route53.AaaaRecord(this, 'ApiAliasAaaa', { zone, recordName: apiDomain, target: apiAlias });

    const apiBaseUrl = `https://${apiDomain}`;
    const publicParameters: Record<string, string> = {
      region: this.region,
      'user-pool-id': pool.userPoolId,
      'user-pool-client-id': webClient.userPoolClientId,
      'api-base-url': apiBaseUrl,
      'contract-hash': contractHash,
    };
    for (const [name, value] of Object.entries(publicParameters)) {
      new ssm.StringParameter(this, `Parameter${name.replaceAll('-', '')}`, {
        parameterName: `${parameterPrefix}/${name}`,
        stringValue: value,
        description: `RoadMap2U ${stage} public client configuration: ${name}`,
      });
    }

    new CfnOutput(this, 'ConfigRegion', { value: this.region });
    new CfnOutput(this, 'ConfigUserPoolId', { value: pool.userPoolId });
    new CfnOutput(this, 'ConfigUserPoolClientId', { value: webClient.userPoolClientId });
    new CfnOutput(this, 'ConfigApiBaseUrl', { value: apiBaseUrl });
    new CfnOutput(this, 'ContractHash', { value: contractHash });
  }
}

/** Private S3 + CloudFront hosting for one PWA deployment stage. */
export class RoadmapHostingStack extends Stack {
  constructor(scope: Construct, id: string, props: RoadmapHostingStackProps) {
    super(scope, id, props);

    const { stage, hostedZoneId } = props;
    assertDeploymentStage(stage);
    if (props.env?.region && props.env.region !== 'us-east-1') {
      throw new Error('RoadMap2U infrastructure must be deployed in us-east-1.');
    }

    const production = stage === 'prod';
    const removalPolicy = production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const frontendDomain = frontendDomainFor(stage);
    const parameterPrefix = `/roadmap2u/${stage}`;
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId,
      zoneName: ROOT_DOMAIN,
    });

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `roadmap2u-${stage}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: !production,
    });

    const certificate = new certificatemanager.Certificate(this, 'SiteCertificate', {
      domainName: frontendDomain,
      subjectAlternativeNames: production ? [`www.${ROOT_DOMAIN}`] : undefined,
      validation: certificatemanager.CertificateValidation.fromDns(zone),
    });
    Tags.of(certificate).add('roadmap2u-project', 'RoadMap2U');
    Tags.of(certificate).add('roadmap2u-stage', stage);

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `roadmap2u-${stage}-security-headers`,
      comment: `Baseline browser security headers for RoadMap2U ${stage}`,
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: production,
          preload: production,
          override: true,
        },
      },
    });

    const requestRouter = new cloudfront.Function(this, 'RequestRouter', {
      functionName: `roadmap2u-${stage}-request-router`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Redirect the production www host and serve index.html for Angular routes',
      code: cloudfront.FunctionCode.fromInline(cloudFrontRequestRouterCode(stage)),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `RoadMap2U ${stage} PWA`,
      defaultRootObject: 'index.html',
      domainNames: production ? [ROOT_DOMAIN, `www.${ROOT_DOMAIN}`] : [frontendDomain],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      sslSupportMethod: cloudfront.SSLMethod.SNI,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy,
        functionAssociations: [
          {
            function: requestRouter,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
    });
    Tags.of(distribution).add('roadmap2u-project', 'RoadMap2U');
    Tags.of(distribution).add('roadmap2u-stage', stage);

    // The current production apex/www records remain untouched until the
    // separately gated cutover workflow is explicitly enabled.
    if (!production) {
      const frontendAlias = route53.RecordTarget.fromAlias(new CloudFrontTarget(distribution));
      new route53.ARecord(this, 'FrontendAliasA', {
        zone,
        recordName: frontendDomain,
        target: frontendAlias,
      });
      new route53.AaaaRecord(this, 'FrontendAliasAaaa', {
        zone,
        recordName: frontendDomain,
        target: frontendAlias,
      });
    }

    const publicParameters: Record<string, string> = {
      'frontend-bucket': siteBucket.bucketName,
      'cloudfront-distribution-id': distribution.distributionId,
      'frontend-url': `https://${frontendDomain}`,
    };
    for (const [name, value] of Object.entries(publicParameters)) {
      new ssm.StringParameter(this, `Parameter${name.replaceAll('-', '')}`, {
        parameterName: `${parameterPrefix}/${name}`,
        stringValue: value,
        description: `RoadMap2U ${stage} frontend delivery configuration: ${name}`,
      });
    }

    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
    });
    new CfnOutput(this, 'FrontendUrl', { value: `https://${frontendDomain}` });
  }
}

const STAGES: DeploymentStage[] = ['dev', 'test', 'prod'];

/**
 * One-time IAM bootstrap. It trusts only GitHub Environment subjects and
 * creates separate, stage-selected deploy roles for the frontend and backend.
 * Effective CloudFormation isolation still depends on each toolkit execution policy.
 */
export class RoadmapCiBootstrapStack extends Stack {
  constructor(scope: Construct, id: string, props: RoadmapCiBootstrapStackProps) {
    super(scope, id, props);

    if (props.env?.region && props.env.region !== 'us-east-1') {
      throw new Error('RoadMap2U infrastructure must be deployed in us-east-1.');
    }

    const provider = new iam.CfnOIDCProvider(this, 'GitHubActionsProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIdList: ['sts.amazonaws.com'],
    });
    provider.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const providerArn = `arn:${Aws.PARTITION}:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;

    for (const stage of STAGES) {
      const backendRole = this.createBackendRole(providerArn, stage, props);
      const frontendRole = this.createFrontendRole(providerArn, stage, props);
      backendRole.node.addDependency(provider);
      frontendRole.node.addDependency(provider);
      new CfnOutput(this, `${stage}BackendRoleArn`, { value: backendRole.roleArn });
      new CfnOutput(this, `${stage}FrontendRoleArn`, { value: frontendRole.roleArn });
    }

    const dnsPlanRole = this.createDnsPlanRole(providerArn, props);
    dnsPlanRole.node.addDependency(provider);
    new CfnOutput(this, 'prodDnsPlanRoleArn', { value: dnsPlanRole.roleArn });

    const dnsCutoverRole = this.createDnsCutoverRole(providerArn, props);
    dnsCutoverRole.node.addDependency(provider);
    new CfnOutput(this, 'prodDnsCutoverRoleArn', { value: dnsCutoverRole.roleArn });
  }

  private githubPrincipal(
    providerArn: string,
    owner: string,
    repository: string,
    environment: string | readonly string[],
  ): iam.FederatedPrincipal {
    const environments = typeof environment === 'string' ? [environment] : [...environment];
    const subjects = environments.map((name) => `repo:${owner}/${repository}:environment:${name}`);
    return new iam.FederatedPrincipal(
      providerArn,
      {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': subjects.length === 1 ? subjects[0] : subjects,
        },
      },
      'sts:AssumeRoleWithWebIdentity',
    );
  }

  private parameterArn(path: string): string {
    return Arn.format(
      {
        partition: Aws.PARTITION,
        service: 'ssm',
        region: this.region,
        account: this.account,
        resource: 'parameter',
        resourceName: path.replace(/^\//, ''),
      },
      this,
    );
  }

  private markerReadArns(stage: DeploymentStage, repo: 'backend' | 'frontend'): string[] {
    const own = [
      this.parameterArn(`/roadmap2u/${stage}/${repo}-release-sha`),
      this.parameterArn(`/roadmap2u/${stage}/${repo}-releases/*`),
    ];
    const previous = stage === 'test' ? 'dev' : stage === 'prod' ? 'test' : undefined;
    return previous
      ? [...own, this.parameterArn(`/roadmap2u/${previous}/${repo}-releases/*`)]
      : own;
  }

  private markerWriteArns(stage: DeploymentStage, repo: 'backend' | 'frontend'): string[] {
    return [
      this.parameterArn(`/roadmap2u/${stage}/${repo}-release-sha`),
      this.parameterArn(`/roadmap2u/${stage}/${repo}-releases/*`),
    ];
  }

  private createBackendRole(
    providerArn: string,
    stage: DeploymentStage,
    props: RoadmapCiBootstrapStackProps,
  ): iam.Role {
    const bootstrapQualifier = bootstrapQualifierFor(stage);
    const role = new iam.Role(this, `BackendDeployRole${stage}`, {
      roleName: `roadmap2u-${stage}-backend-deploy`,
      description: `GitHub Actions backend deploy role for RoadMap2U ${stage}`,
      assumedBy: this.githubPrincipal(
        providerArn,
        props.githubOwner,
        props.backendRepository,
        stage,
      ),
      maxSessionDuration: Duration.hours(1),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UseCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
          (purpose) =>
            `arn:${Aws.PARTITION}:iam::${this.account}:role/cdk-${bootstrapQualifier}-${purpose}-role-${this.account}-us-east-1`,
        ),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCloudFormationStatus',
        actions: [
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:GetTemplate',
        ],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadReleaseProofAndPublicConfig',
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          this.parameterArn(`/roadmap2u/${stage}/*`),
          ...this.markerReadArns(stage, 'backend'),
          this.parameterArn(`/cdk-bootstrap/${bootstrapQualifier}/version`),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteBackendReleaseProof',
        actions: ['ssm:PutParameter'],
        resources: this.markerWriteArns(stage, 'backend'),
      }),
    );
    return role;
  }

  private createDnsCutoverRole(providerArn: string, props: RoadmapCiBootstrapStackProps): iam.Role {
    const role = new iam.Role(this, 'ProductionDnsCutoverRole', {
      roleName: 'roadmap2u-prod-dns-cutover',
      description:
        'Explicitly selected GitHub Actions role for the RoadMap2U production DNS cutover',
      assumedBy: this.githubPrincipal(
        providerArn,
        props.githubOwner,
        props.backendRepository,
        'prod-dns-cutover',
      ),
      maxSessionDuration: Duration.hours(1),
    });
    const hostedZoneArn = `arn:${Aws.PARTITION}:route53:::hostedzone/${props.hostedZoneId}`;

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ChangeOnlyRoadmapProductionRecords',
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [hostedZoneArn],
        conditions: {
          'ForAllValues:StringEquals': {
            'route53:ChangeResourceRecordSetsNormalizedRecordNames': [
              ROOT_DOMAIN,
              `www.${ROOT_DOMAIN}`,
            ],
            'route53:ChangeResourceRecordSetsRecordTypes': ['A', 'AAAA', 'CNAME'],
            'route53:ChangeResourceRecordSetsActions': ['UPSERT', 'DELETE'],
          },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InspectOnlyRoadmapProductionZone',
        actions: ['route53:GetHostedZone', 'route53:ListResourceRecordSets'],
        resources: [hostedZoneArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WaitForRoadmapDnsChange',
        actions: ['route53:GetChange'],
        resources: [`arn:${Aws.PARTITION}:route53:::change/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PersistOnlyProductionDnsBackup',
        actions: ['ssm:PutParameter'],
        resources: [this.parameterArn('/roadmap2u/prod/dns-cutover-backup')],
      }),
    );
    return role;
  }

  private createDnsPlanRole(providerArn: string, props: RoadmapCiBootstrapStackProps): iam.Role {
    const role = new iam.Role(this, 'ProductionDnsPlanRole', {
      roleName: 'roadmap2u-prod-dns-plan',
      description:
        'Read-only GitHub Actions role for reviewing the RoadMap2U production DNS cutover',
      assumedBy: this.githubPrincipal(
        providerArn,
        props.githubOwner,
        props.backendRepository,
        'prod',
      ),
      maxSessionDuration: Duration.hours(1),
    });
    const hostedZoneArn = `arn:${Aws.PARTITION}:route53:::hostedzone/${props.hostedZoneId}`;

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InspectOnlyRoadmapProductionZone',
        actions: ['route53:GetHostedZone', 'route53:ListResourceRecordSets'],
        resources: [hostedZoneArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ValidatePreparedProductionDistribution',
        actions: ['cloudfront:GetDistribution'],
        resources: [`arn:${Aws.PARTITION}:cloudfront::${this.account}:distribution/*`],
        conditions: {
          StringEquals: {
            'aws:ResourceTag/roadmap2u-project': 'RoadMap2U',
            'aws:ResourceTag/roadmap2u-stage': 'prod',
          },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ValidatePreparedProductionCertificate',
        actions: ['acm:DescribeCertificate'],
        resources: [`arn:${Aws.PARTITION}:acm:us-east-1:${this.account}:certificate/*`],
        conditions: {
          StringEquals: {
            'aws:ResourceTag/roadmap2u-project': 'RoadMap2U',
            'aws:ResourceTag/roadmap2u-stage': 'prod',
          },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadCutoverInputs',
        actions: ['ssm:GetParameter'],
        resources: [
          this.parameterArn('/roadmap2u/prod/cloudfront-distribution-id'),
          this.parameterArn('/roadmap2u/prod/backend-release-sha'),
          this.parameterArn('/roadmap2u/prod/frontend-release-sha'),
          this.parameterArn('/roadmap2u/prod/dns-cutover-backup'),
        ],
      }),
    );
    return role;
  }

  private createFrontendRole(
    providerArn: string,
    stage: DeploymentStage,
    props: RoadmapCiBootstrapStackProps,
  ): iam.Role {
    const role = new iam.Role(this, `FrontendDeployRole${stage}`, {
      roleName: `roadmap2u-${stage}-frontend-deploy`,
      description: `GitHub Actions frontend deploy role for RoadMap2U ${stage}`,
      assumedBy: this.githubPrincipal(
        providerArn,
        props.githubOwner,
        props.frontendRepository,
        stage,
      ),
      maxSessionDuration: Duration.hours(1),
    });
    const bucketArn = `arn:${Aws.PARTITION}:s3:::roadmap2u-${stage}-${this.account}`;

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadFrontendConfigAndReleaseProof',
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          this.parameterArn(`/roadmap2u/${stage}/*`),
          ...this.markerReadArns(stage, 'frontend'),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteFrontendReleaseProof',
        actions: ['ssm:PutParameter'],
        resources: this.markerWriteArns(stage, 'frontend'),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishFrontendObjects',
        actions: ['s3:GetBucketLocation', 's3:ListBucket'],
        resources: [bucketArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishFrontendObjectVersions',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [`${bucketArn}/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvalidateStageDistribution',
        actions: [
          'cloudfront:CreateInvalidation',
          'cloudfront:GetDistribution',
          'cloudfront:GetInvalidation',
        ],
        resources: [`arn:${Aws.PARTITION}:cloudfront::${this.account}:distribution/*`],
        conditions: {
          StringEquals: {
            'aws:ResourceTag/roadmap2u-project': 'RoadMap2U',
            'aws:ResourceTag/roadmap2u-stage': stage,
          },
        },
      }),
    );
    return role;
  }
}
