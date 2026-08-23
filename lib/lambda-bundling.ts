import { OutputFormat, type BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';

export const BUNDLED_AWS_SDK_ESM_BANNER =
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

// Smithy's Node transport still performs dynamic CommonJS requires inside an ESM bundle.
export function bundledAwsSdkEsm(tsconfig: string): BundlingOptions {
  return {
    bundleAwsSDK: true,
    format: OutputFormat.ESM,
    tsconfig,
    target: 'node22',
    banner: BUNDLED_AWS_SDK_ESM_BANNER,
  };
}
