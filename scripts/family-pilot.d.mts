export function buildFamilyPilotRequest(command: 'grant' | 'revoke', argv: string[]): {
  body: {
    command: 'grant' | 'revoke';
    stage: string;
    adultId: string;
    householdId: string;
    expectedHouseholdRevision: number;
    expectedEntitlementRevision: number;
    commandId: string;
    reason: string;
  };
  hash: string;
};

export function runFamilyPilotCli(
  command: 'grant' | 'revoke',
  argv: string[],
  deps?: {
    write?: (value: string) => void;
    runAwsJson?: (...args: unknown[]) => unknown;
    getCredentials?: (...args: unknown[]) => Promise<unknown>;
    fetchRequest?: (...args: unknown[]) => Promise<unknown>;
  },
): Promise<{ applied: boolean; hash?: string; result?: unknown }>;
