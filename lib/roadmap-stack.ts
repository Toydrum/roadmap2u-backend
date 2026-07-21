import {
  Arn,
  Aws,
  BootstraplessSynthesizer,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
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
import * as logs from 'aws-cdk-lib/aws-logs';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties, CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD_POLICY } from '@app/auth/auth-types';
import { createStageManagedPolicies } from './stage-policies';

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
  readonly githubOwnerId: string;
  readonly backendRepository: string;
  readonly backendRepositoryId: string;
  readonly frontendRepository: string;
  readonly frontendRepositoryId: string;
  readonly operationsPrincipalArn: string;
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

export function createCiBootstrapSynthesizer(): BootstraplessSynthesizer {
  return new BootstraplessSynthesizer();
}

function logRetentionFor(stage: DeploymentStage): logs.RetentionDays {
  return {
    dev: logs.RetentionDays.ONE_WEEK,
    test: logs.RetentionDays.TWO_WEEKS,
    prod: logs.RetentionDays.ONE_MONTH,
  }[stage];
}

function runtimeBoundaryArn(stack: Stack, stage: DeploymentStage): string {
  return Arn.format(
    {
      partition: Aws.PARTITION,
      service: 'iam',
      region: '',
      account: stack.account,
      resource: 'policy',
      resourceName: `roadmap2u/${stage}/roadmap2u-${stage}-runtime-boundary`,
    },
    stack,
  );
}

function createRuntimeRole(
  scope: Stack,
  id: string,
  stage: DeploymentStage,
): iam.Role {
  return new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    path: `/roadmap2u/${stage}/runtime/`,
    permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(
      scope,
      `${id}Boundary`,
      runtimeBoundaryArn(scope, stage),
    ),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    ],
  });
}

function createFunctionLogGroup(
  scope: Stack,
  id: string,
  functionName: string,
  stage: DeploymentStage,
): logs.LogGroup {
  const group = new logs.LogGroup(scope, id, {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logRetentionFor(stage),
    removalPolicy: stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  });
  return group;
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
    Tags.of(this).add('roadmap2u-project', 'RoadMap2U');
    Tags.of(this).add('roadmap2u-stage', stage);
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId,
      zoneName: ROOT_DOMAIN,
    });

    const preSignUpName = `roadmap-pre-signup-${stage}`;
    const preSignUp = new NodejsFunction(this, 'PreSignUp', {
      functionName: preSignUpName,
      entry: join(here, '../lambda/pre-signup.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      role: createRuntimeRole(this, 'PreSignUpRole', stage),
      logGroup: createFunctionLogGroup(this, 'PreSignUpLogs', preSignUpName, stage),
      bundling: {
        format: OutputFormat.ESM,
        tsconfig: join(here, '../tsconfig.json'),
        target: 'node22',
      },
    });

    const postConfirmationName = `roadmap-post-confirmation-${stage}`;
    const postConfirmation = new NodejsFunction(this, 'PostConfirmation', {
      functionName: postConfirmationName,
      entry: join(here, '../lambda/post-confirmation.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(10),
      role: createRuntimeRole(this, 'PostConfirmationRole', stage),
      logGroup: createFunctionLogGroup(
        this,
        'PostConfirmationLogs',
        postConfirmationName,
        stage,
      ),
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
      email: cognito.UserPoolEmail.withCognito(),
      userVerification: { emailStyle: cognito.VerificationEmailStyle.CODE },
      deletionProtection: production,
      removalPolicy,
      lambdaTriggers: { preSignUp, postConfirmation },
    });

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

    const routerName = `roadmap-router-${stage}`;
    const router = new NodejsFunction(this, 'Router', {
      functionName: routerName,
      entry: join(here, '../lambda/router.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(15),
      role: createRuntimeRole(this, 'RouterRole', stage),
      logGroup: createFunctionLogGroup(this, 'RouterLogs', routerName, stage),
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
    const customDomain = new apigatewayv2.DomainName(this, 'ApiDomain', {
      domainName: apiDomain,
      certificate: apiCertificate,
      securityPolicy: apigatewayv2.SecurityPolicy.TLS_1_2,
    });
    const api = new apigatewayv2.HttpApi(this, 'Api', {
      apiName: `roadmap-api-${stage}`,
      createDefaultStage: false,
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
    const apiLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      'ApiAccessLogs',
      Fn.importValue(`RoadMap2U-${stage}-ApiAccessLogGroupName`),
    );
    new apigatewayv2.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      domainMapping: { domainName: customDomain },
      accessLogSettings: {
        destination: new apigatewayv2.LogGroupLogDestination(apiLogGroup),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            routeKey: '$context.routeKey',
            status: '$context.status',
            responseLength: '$context.responseLength',
            latency: '$context.responseLatency',
          }),
        ),
      },
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
    Tags.of(this).add('roadmap2u-project', 'RoadMap2U');
    Tags.of(this).add('roadmap2u-stage', stage);
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
      autoDeleteObjects: false,
    });

    const certificate = new certificatemanager.Certificate(this, 'SiteCertificate', {
      domainName: frontendDomain,
      subjectAlternativeNames: production ? [`www.${ROOT_DOMAIN}`] : undefined,
      validation: certificatemanager.CertificateValidation.fromDns(zone),
    });

    const responseHeadersPolicy = cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS;
    const originAccessControl = cloudfront.S3OriginAccessControl.fromOriginAccessControlId(
      this,
      'SiteOriginAccessControl',
      Fn.importValue(`RoadMap2U-${stage}-SiteOacId`),
    );

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
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket, {
          originAccessControl,
        }),
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

    Tags.of(this).add('roadmap2u-project', 'RoadMap2U');
    const providerArn = `arn:${Aws.PARTITION}:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;

    for (const stage of STAGES) {
      const policies = createStageManagedPolicies(this, stage, props.hostedZoneId);
      const backendRole = this.createBackendRole(providerArn, stage, props);
      const frontendRole = this.createFrontendRole(providerArn, stage, props);
      const smokeCleanupRole = this.createSmokeCleanupRole(props.operationsPrincipalArn, stage);
      new CfnOutput(this, `${stage}BackendRoleArn`, { value: backendRole.roleArn });
      new CfnOutput(this, `${stage}FrontendRoleArn`, { value: frontendRole.roleArn });
      new CfnOutput(this, `${stage}SmokeCleanupRoleArn`, { value: smokeCleanupRole.roleArn });
      new CfnOutput(this, `${stage}CfnCorePolicyArn`, { value: policies.core.managedPolicyArn });
      new CfnOutput(this, `${stage}CfnApiPolicyArn`, { value: policies.api.managedPolicyArn });
      new CfnOutput(this, `${stage}CfnDataPolicyArn`, { value: policies.data.managedPolicyArn });
      new CfnOutput(this, `${stage}CfnEdgePolicyArn`, { value: policies.edge.managedPolicyArn });
      new CfnOutput(this, `${stage}RuntimeBoundaryArn`, {
        value: policies.runtimeBoundary.managedPolicyArn,
      });
    }

    const breakGlassRole = this.createNonProdBreakGlassRole(props.operationsPrincipalArn);
    new CfnOutput(this, 'nonProdBreakGlassRoleArn', { value: breakGlassRole.roleArn });

    const dnsPlanRole = this.createDnsPlanRole(providerArn, props);
    new CfnOutput(this, 'prodDnsPlanRoleArn', { value: dnsPlanRole.roleArn });

    const dnsCutoverRole = this.createDnsCutoverRole(providerArn, props);
    new CfnOutput(this, 'prodDnsCutoverRoleArn', { value: dnsCutoverRole.roleArn });
  }

  private githubPrincipal(
    providerArn: string,
    owner: string,
    ownerId: string,
    repository: string,
    repositoryId: string,
    environment: string | readonly string[],
  ): iam.FederatedPrincipal {
    const environments = typeof environment === 'string' ? [environment] : [...environment];
    const subjects = environments.map(
      (name) => `repo:${owner}@${ownerId}/${repository}@${repositoryId}:environment:${name}`,
    );
    return new iam.FederatedPrincipal(
      providerArn,
      {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': subjects.length === 1 ? subjects[0] : subjects,
          'token.actions.githubusercontent.com:repository_owner_id': ownerId,
          'token.actions.githubusercontent.com:repository_id': repositoryId,
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

  private mfaUserPrincipal(principalArn: string): iam.IPrincipal {
    return new iam.ArnPrincipal(principalArn).withConditions({
      Bool: { 'aws:MultiFactorAuthPresent': 'true' },
      NumericLessThanEquals: { 'aws:MultiFactorAuthAge': '3600' },
    });
  }

  private createNonProdBreakGlassRole(principalArn: string): iam.Role {
    const role = new iam.Role(this, 'NonProdBreakGlassRole', {
      roleName: 'roadmap2u-nonprod-break-glass',
      description: 'MFA-only deletion role for RoadMap2U dev and test workload stacks',
      assumedBy: this.mfaUserPrincipal(principalArn),
      path: '/roadmap2u/operations/',
      maxSessionDuration: Duration.hours(1),
    });
    Tags.of(role).add('roadmap2u-project', 'RoadMap2U');
    Tags.of(role).add('roadmap2u-purpose', 'nonprod-break-glass');

    const resources = (['dev', 'test'] as const).flatMap((stage) =>
      ['Backend', 'Hosting'].map(
        (stackType) =>
          `arn:${Aws.PARTITION}:cloudformation:us-east-1:${this.account}:stack/Roadmap-${stage}-${stackType}/*`,
      ),
    );
    role.attachInlinePolicy(
      new iam.Policy(this, 'NonProdBreakGlassPolicy', {
        policyName: 'NonProdBreakGlassPolicy',
        statements: [
          new iam.PolicyStatement({
            sid: 'DeleteOnlyNonProdWorkloadStacks',
            actions: [
              'cloudformation:DeleteStack',
              'cloudformation:DescribeStackEvents',
              'cloudformation:DescribeStacks',
            ],
            resources,
          }),
          new iam.PolicyStatement({
            sid: 'ListOnlyNonProdHostingVersions',
            actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketVersions'],
            resources: (['dev', 'test'] as const).map(
              (stage) => `arn:${Aws.PARTITION}:s3:::roadmap2u-${stage}-${this.account}`,
            ),
          }),
          new iam.PolicyStatement({
            sid: 'DeleteOnlyNonProdHostingVersions',
            actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
            resources: (['dev', 'test'] as const).map(
              (stage) => `arn:${Aws.PARTITION}:s3:::roadmap2u-${stage}-${this.account}/*`,
            ),
          }),
        ],
      }),
    );
    return role;
  }

  private createSmokeCleanupRole(principalArn: string, stage: DeploymentStage): iam.Role {
    const role = new iam.Role(this, `SmokeCleanupRole${stage}`, {
      roleName: `roadmap2u-${stage}-smoke-cleanup`,
      description: `MFA-only deletion of RoadMap2U ${stage} smoke users and their application records`,
      assumedBy: this.mfaUserPrincipal(principalArn),
      path: `/roadmap2u/${stage}/operations/`,
      maxSessionDuration: Duration.hours(1),
    });
    Tags.of(role).add('roadmap2u-project', 'RoadMap2U');
    Tags.of(role).add('roadmap2u-stage', stage);
    Tags.of(role).add('roadmap2u-purpose', 'smoke-cleanup');

    const stageTagConditions = {
      StringEquals: {
        'aws:ResourceTag/roadmap2u-project': 'RoadMap2U',
        'aws:ResourceTag/roadmap2u-stage': stage,
      },
    };
    const tableArn = `arn:${Aws.PARTITION}:dynamodb:us-east-1:${this.account}:table/roadmap-${stage}`;
    role.attachInlinePolicy(
      new iam.Policy(this, `SmokeCleanupPolicy${stage}`, {
        policyName: `SmokeCleanupPolicy-${stage}`,
        statements: [
          new iam.PolicyStatement({
            sid: 'DeleteOnlyTaggedRoadMap2USmokeUsers',
            actions: ['cognito-idp:AdminDeleteUser', 'cognito-idp:AdminGetUser'],
            resources: [
              `arn:${Aws.PARTITION}:cognito-idp:us-east-1:${this.account}:userpool/*`,
            ],
            conditions: stageTagConditions,
          }),
          new iam.PolicyStatement({
            sid: 'DeleteOnlyTaggedRoadMap2USmokeRecords',
            actions: ['dynamodb:DeleteItem', 'dynamodb:Query'],
            resources: [tableArn, `${tableArn}/index/*`],
            conditions: stageTagConditions,
          }),
          new iam.PolicyStatement({
            sid: 'ReadOnlyStageUserPoolIds',
            actions: ['ssm:GetParameter'],
            resources: [this.parameterArn(`/roadmap2u/${stage}/user-pool-id`)],
          }),
        ],
      }),
    );
    return role;
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

  private publicConfigArns(stage: DeploymentStage): string[] {
    return [
      'region',
      'user-pool-id',
      'user-pool-client-id',
      'api-base-url',
      'frontend-bucket',
      'cloudfront-distribution-id',
      'frontend-url',
      'contract-hash',
    ].map((name) => this.parameterArn(`/roadmap2u/${stage}/${name}`));
  }

  private backendReleaseManifestArn(stage: DeploymentStage): string {
    return this.parameterArn(`/roadmap2u/${stage}/backend-release-manifests/*`);
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
        props.githubOwnerId,
        props.backendRepository,
        props.backendRepositoryId,
        stage,
      ),
      path: `/roadmap2u/${stage}/`,
      maxSessionDuration: Duration.hours(1),
    });
    Tags.of(role).add('roadmap2u-stage', stage);

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UseCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: ['deploy', 'file-publishing'].map(
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
        resources: ['Backend', 'Hosting'].map(
          (stackType) =>
            `arn:${Aws.PARTITION}:cloudformation:us-east-1:${this.account}:stack/Roadmap-${stage}-${stackType}/*`,
        ),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: `ReadReleaseProofAndPublicConfig${stage}`,
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          ...this.publicConfigArns(stage),
          ...this.markerReadArns(stage, 'backend'),
          this.backendReleaseManifestArn(stage),
          this.parameterArn(`/cdk-bootstrap/${bootstrapQualifier}/version`),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: `WriteBackendReleaseProof${stage}`,
        actions: ['ssm:PutParameter'],
        resources: [
          ...this.markerWriteArns(stage, 'backend'),
          this.backendReleaseManifestArn(stage),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: `InspectStageLogRetention${stage}`,
        actions: ['logs:DescribeLogGroups'],
        resources: ['*'],
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
        props.githubOwnerId,
        props.backendRepository,
        props.backendRepositoryId,
        'prod-dns-cutover',
      ),
      path: '/roadmap2u/prod/',
      maxSessionDuration: Duration.hours(1),
    });
    Tags.of(role).add('roadmap2u-stage', 'prod');
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
        props.githubOwnerId,
        props.backendRepository,
        props.backendRepositoryId,
        'prod',
      ),
      path: '/roadmap2u/prod/',
      maxSessionDuration: Duration.hours(1),
    });
    Tags.of(role).add('roadmap2u-stage', 'prod');
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
        props.githubOwnerId,
        props.frontendRepository,
        props.frontendRepositoryId,
        stage,
      ),
      path: `/roadmap2u/${stage}/`,
      maxSessionDuration: Duration.hours(1),
    });
    Tags.of(role).add('roadmap2u-stage', stage);
    const bucketArn = `arn:${Aws.PARTITION}:s3:::roadmap2u-${stage}-${this.account}`;

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: `ReadFrontendConfigAndReleaseProof${stage}`,
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          ...this.publicConfigArns(stage),
          ...this.markerReadArns(stage, 'frontend'),
          this.parameterArn(`/roadmap2u/${stage}/backend-release-sha`),
          this.parameterArn(`/roadmap2u/${stage}/backend-releases/*`),
          this.backendReleaseManifestArn(stage),
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
