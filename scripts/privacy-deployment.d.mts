export interface PrivacyDeploymentDecision {
  supported: boolean;
  expected: { adult: 'off' | 'enforce'; adolescent: 'off' | 'enforce' };
  parameters: string[];
}
export function resolvePrivacyDeployment(input: {
  stage: unknown;
  operation: unknown;
  adult?: unknown;
  adolescent?: unknown;
  releaseTemplate: unknown;
  currentStack: unknown;
}): PrivacyDeploymentDecision;
