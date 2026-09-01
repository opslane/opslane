import { logger, safeErrorMessage } from './logger.js';

const DEFAULT_BASE_URL = 'https://api.useautumn.com';
// Verified paths must stay in sync with packages/ingestion/billing/client.go.
const AUTUMN_API_VERSION = '2.3.0';
const PATH_CUSTOMERS = '/v1/customers.get_or_create';
const PATH_CHECK = '/v1/balances.check';

export type BillingFeatureID = 'merged_prs' | 'investigations';

export interface QuotaResult {
  allowed: boolean;
  failedOpen: boolean;
}

export function billingEnabled(): boolean {
  return Boolean(process.env['AUTUMN_SECRET_KEY']?.trim());
}

function valueOrDefault(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

async function autumnPost(path: string, body: Record<string, unknown>): Promise<Response> {
  const baseURL = valueOrDefault(process.env['AUTUMN_BASE_URL'], DEFAULT_BASE_URL).replace(/\/+$/, '');
  return fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env['AUTUMN_SECRET_KEY']?.trim() ?? ''}`,
      'x-api-version': AUTUMN_API_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

export async function checkQuota(
  orgId: string,
  orgName: string,
  featureId: BillingFeatureID,
  opts: { sendEvent?: boolean } = {},
): Promise<QuotaResult> {
  if (!billingEnabled()) return { allowed: true, failedOpen: false };
  try {
    const customer = await autumnPost(PATH_CUSTOMERS, {
      customer_id: orgId,
      name: orgName,
      auto_enable_plan_id: valueOrDefault(process.env['AUTUMN_FREE_PLAN_ID'], 'free'),
    });
    if (!customer.ok) throw new Error(`Autumn customers status ${customer.status}`);

    const response = await autumnPost(PATH_CHECK, {
      customer_id: orgId,
      feature_id: featureId,
      ...(opts.sendEvent ? { send_event: true } : {}),
    });
    if (!response.ok) throw new Error(`Autumn check status ${response.status}`);
    const data: unknown = await response.json();
    const allowed = typeof data === 'object' && data !== null && 'allowed' in data
      ? (data as { allowed: unknown }).allowed
      : undefined;
    if (typeof allowed !== 'boolean') {
      logger.warn('billing check malformed response; failing open', { feature: featureId });
      return { allowed: true, failedOpen: true };
    }
    return { allowed, failedOpen: false };
  } catch (error: unknown) {
    logger.warn('billing check failed open', {
      feature: featureId,
      error: safeErrorMessage(error),
    });
    return { allowed: true, failedOpen: true };
  }
}
