# Security policy

Report suspected vulnerabilities through the repository's private GitHub security advisory flow. Do not include credentials, personal data, AWS account identifiers, hosted-zone IDs or exploit details in a public issue.

## Dependency policy

Production dependency audits cover the packages that can reach the Lambda bundles:

```bash
npm audit --omit=dev --audit-level=high
```

GitHub Actions are pinned to immutable commit SHAs. CI and deployment installs use `npm ci --ignore-scripts`; deployment then invokes the already-installed CDK CLI with `npx --no-install`.

Dependabot monitors both npm and GitHub Actions weekly.

## Known upstream tooling advisory

As of 2026-07-20, `aws-cdk-lib@2.261.0` bundles `brace-expansion@5.0.6`, which is covered by [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp). The current AWS CDK release has no patched bundled version, and npm cannot override or automatically repair a bundled dependency.

This package is development-time infrastructure tooling and is not included in Lambda or browser artifacts. The deployable dependency audit currently reports zero vulnerabilities. The temporary controls are:

- immutable dependency and Action references;
- disabled dependency lifecycle scripts;
- no AWS credentials in the dependency-install step;
- trusted, stage-proven release SHAs for promotions;
- weekly dependency monitoring.

Upgrade AWS CDK and remove this exception as soon as an official release bundles `brace-expansion` 5.0.7 or later.
