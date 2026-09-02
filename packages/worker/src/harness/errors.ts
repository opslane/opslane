import type { EvidenceRecord } from '@opslane/shared';
import type { DeadLetterClass } from './model-failure-policy.js';

/** A job outcome that retrying cannot change. */
export class NonRetryableJobError extends Error {
  override readonly name = 'NonRetryableJobError';

  constructor(
    message: string,
    readonly deadLetterClass: DeadLetterClass,
    readonly detail: { stop?: string; costUsd?: number } = {},
  ) {
    super(message);
  }
}

/**
 * Signals that verification could not produce a patch verdict because the
 * sandbox, dependency install, or test runner failed persistently.
 */
export class VerificationInfraError extends Error {
  constructor(
    message: string,
    readonly evidence: EvidenceRecord,
  ) {
    super(message);
    this.name = 'VerificationInfraError';
  }
}

/** The configured sandbox template cannot provide the runtime a job requires. */
export class SandboxImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxImageError';
  }
}

/** The machine could not serve the request. `state` never claims death it cannot prove. */
export class MachineUnavailableError extends Error {
  constructor(
    message: string,
    readonly state: 'gone' | 'unknown',
  ) {
    super(message);
    this.name = 'MachineUnavailableError';
  }
}

/** The customer's dependency list could not be installed. `output` is already scrubbed. */
export class DependencyInstallError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = 'DependencyInstallError';
  }
}
