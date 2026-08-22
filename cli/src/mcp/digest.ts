import type { DigestCard, LatestDigest } from './types.js';

export interface DigestFormatInput {
  runDate: string | null;
  cards: DigestCard[];
  projectLabel: string;
}

/** Maps the API's snake_case envelope into the formatter's display input. */
export function toDigestFormatInput(
  digest: LatestDigest,
  projectLabel: string,
): DigestFormatInput {
  return {
    runDate: digest.run_date,
    cards: digest.cards,
    projectLabel,
  };
}
