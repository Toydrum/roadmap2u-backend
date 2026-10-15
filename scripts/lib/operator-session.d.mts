export type OperatorStage = 'dev' | 'test' | 'prod';
export type OperatorPurpose = 'migration' | 'flags' | 'pilot' | 'fixture';
export interface OperatorProfile {
  stage: OperatorStage; purpose: OperatorPurpose; profile: string; roleName: string;
  roleArn: string; sourceProfile: string; roleSessionName: string; durationSeconds: number; region: string;
}
export interface OperatorSession {
  stage: OperatorStage; purpose: OperatorPurpose; profile: string; expiration: string;
  identity: { Account: string; Arn: string };
  readonly raw: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration: Date };
  readonly credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };
}
export const OPERATOR_ACCOUNT: string;
export const OPERATOR_REGION: string;
export const OPERATOR_SESSION_SECONDS: number;
export const OPERATOR_MFA_WINDOW_SECONDS: number;
export function buildOperatorProfiles(): OperatorProfile[];
export function createOperatorSessionProvider(options?: {
  exportCredentials?: (profile: string) => unknown | Promise<unknown>;
  getCallerIdentity?: (credentials: OperatorSession['credentials']) => unknown | Promise<unknown>;
  now?: () => number; env?: Record<string, string | undefined>;
}): (stage: string, purpose: string) => Promise<OperatorSession>;
