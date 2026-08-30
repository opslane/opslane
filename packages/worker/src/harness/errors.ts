import type { EvidenceRecord } from '@opslane/shared';

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
