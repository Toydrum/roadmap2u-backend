import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import * as infrastructure from '../lib/roadmap-stack';

const ACCOUNT = '123456789012';
const HOSTED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';
const HostingStack = (infrastructure as unknown as Record<string, any>)['RoadmapHostingStack'];
const requestRouterCode = (infrastructure as unknown as Record<string, any>)[
  'cloudFrontRequestRouterCode'
];

function hostingTemplate(stage: 'dev' | 'test' | 'prod'): Template {
  expect(HostingStack).toBeTypeOf('function');
  const app = new App();
  return Template.fromStack(
    new HostingStack(app, `Roadmap-${stage}-Hosting`, {
      env: { account: ACCOUNT, region: 'us-east-1' },
      stage,
      hostedZoneId: HOSTED_ZONE_ID,
    }),
  );
}

describe('private PWA hosting', () => {
  it.each(['dev', 'test', 'prod'] as const)('globally tags %s hosting resources', (stage) => {
    const template = hostingTemplate(stage).toJSON();
    for (const resourceType of ['AWS::S3::Bucket', 'AWS::SSM::Parameter']) {
      const resources = Object.values(template.Resources).filter(
        (resource: any) => resource.Type === resourceType,
      ) as any[];
      expect(resources.length).toBeGreaterThan(0);
      for (const resource of resources) {
        const tags = Array.isArray(resource.Properties.Tags)
          ? Object.fromEntries(
              resource.Properties.Tags.map((tag: { Key: string; Value: string }) => [
                tag.Key,
                tag.Value,
              ]),
            )
          : resource.Properties.Tags;
        expect(tags).toMatchObject({
          'roadmap2u-project': 'RoadMap2U',
          'roadmap2u-stage': stage,
        });
      }
    }
  });

  it.each(['dev', 'test', 'prod'] as const)(
    'uses a private, encrypted, versioned %s bucket behind CloudFront OAC',
    (stage) => {
      const template = hostingTemplate(stage);
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: `roadmap2u-${stage}-${ACCOUNT}`,
        BucketEncryption: Match.anyValue(),
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: { Status: 'Enabled' },
      });
      template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 0);
      const distribution = Object.values(template.toJSON().Resources).find(
        (resource: any) => resource.Type === 'AWS::CloudFront::Distribution',
      ) as any;
      expect(JSON.stringify(distribution.Properties.DistributionConfig.Origins)).toContain(
        `RoadMap2U-${stage}-SiteOacId`,
      );
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Condition: {
                StringEquals: { 'AWS:SourceArn': Match.anyValue() },
              },
            }),
          ]),
        },
      });
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          { Key: 'roadmap2u-project', Value: 'RoadMap2U' },
          { Key: 'roadmap2u-stage', Value: stage },
        ]),
        DistributionConfig: Match.objectLike({
          DefaultRootObject: 'index.html',
          Enabled: true,
          DefaultCacheBehavior: Match.objectLike({
            Compress: true,
            ViewerProtocolPolicy: 'redirect-to-https',
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: 'viewer-request' }),
            ]),
          }),
        }),
      });
    },
  );

  it('rewrites SPA paths and redirects production www to the apex', () => {
    const template = hostingTemplate('prod');
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['roadmap2u.com', 'www.roadmap2u.com'],
      }),
    });
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'roadmap2u.com',
      SubjectAlternativeNames: ['www.roadmap2u.com'],
      Tags: Match.arrayWith([
        { Key: 'roadmap2u-project', Value: 'RoadMap2U' },
        { Key: 'roadmap2u-stage', Value: 'prod' },
      ]),
    });
    const functions = template.findResources('AWS::CloudFront::Function');
    const functionCode = JSON.stringify(Object.values(functions)[0]);
    expect(functionCode).toContain('www.roadmap2u.com');
    expect(functionCode).toContain('statusCode:301');
    expect(functionCode).toContain('/index.html');
  });

  it('routes trailing-slash deep links and preserves the www query string', () => {
    expect(requestRouterCode).toBeTypeOf('function');
    const code = requestRouterCode('prod');
    const handler = new Function(`${code};return handler;`)();

    expect(
      handler({
        request: {
          uri: '/account/',
          headers: { host: { value: 'roadmap2u.com' } },
          querystring: {},
        },
      }).uri,
    ).toBe('/index.html');

    const redirect = handler({
      request: {
        uri: '/welcome',
        headers: { host: { value: 'www.roadmap2u.com' } },
        querystring: { invite: { value: 'ABC 123' } },
      },
    });
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location.value).toBe(
      'https://roadmap2u.com/welcome?invite=ABC%20123',
    );
  });

  it('publishes baseline browser security headers', () => {
    const template = hostingTemplate('prod');
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ResponseHeadersPolicyId: Match.anyValue(),
        }),
      }),
    });
  });

  it.each([
    ['dev', 'dev.roadmap2u.com', 2],
    ['test', 'test.roadmap2u.com', 2],
    ['prod', 'roadmap2u.com', 0],
  ] as const)('manages only the permitted %s frontend DNS records', (stage, domain, count) => {
    const template = hostingTemplate(stage);
    template.resourceCountIs('AWS::Route53::RecordSet', count);
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: domain,
      DomainValidationOptions: Match.anyValue(),
    });
  });

  it('retains production objects but allows disposable non-production hosting', () => {
    const dev = hostingTemplate('dev').toJSON();
    const prod = hostingTemplate('prod').toJSON();
    const findBucket = (template: any) =>
      Object.values(template.Resources).find((resource: any) => resource.Type === 'AWS::S3::Bucket') as any;

    expect(findBucket(dev).DeletionPolicy).toBe('Delete');
    expect(findBucket(prod).DeletionPolicy).toBe('Retain');
  });

  it('publishes the hosting parameters consumed by frontend delivery', () => {
    const template = hostingTemplate('dev');
    for (const name of ['frontend-bucket', 'cloudfront-distribution-id', 'frontend-url']) {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: `/roadmap2u/dev/${name}`,
        Type: 'String',
      });
    }
    expect(template.toJSON().Outputs).toHaveProperty('DistributionDomainName');
  });
});
