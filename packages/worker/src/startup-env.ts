/** Startup environment contract, split from main() so it is testable. */
const ALWAYS_REQUIRED = ['DATABASE_URL'] as const;
const OPTIONAL = ['ANTHROPIC_API_KEY', 'E2B_API_KEY', 'GITHUB_TOKEN'] as const;

function present(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

export function requiredEnvMissing(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = ALWAYS_REQUIRED.filter((key) => !present(env[key]));
  const backend = env['OPSLANE_SANDBOX_BACKEND']?.trim().toLowerCase() || 'e2b';
  if (
    backend === 'e2b'
    && present(env['E2B_API_KEY'])
    && !present(env['OPSLANE_E2B_JAVASCRIPT_TEMPLATE'])
  ) {
    missing.push('OPSLANE_E2B_JAVASCRIPT_TEMPLATE');
  }
  return missing;
}

export function optionalEnvMissing(env: NodeJS.ProcessEnv): string[] {
  return OPTIONAL.filter((key) => !present(env[key]));
}
