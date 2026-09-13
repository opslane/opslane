import { describe, expect, it } from 'vitest';
import { claimsAbsence } from '../absence.js';

describe('claimsAbsence', () => {
  it.each([
    'There was no response after saving',
    'The form showed no feedback',
    'No loading indicator appeared',
    'Nothing happened when the user clicked',
    "The screen didn't change",
    'Clicking submit does nothing',
    'The button did not respond',
    'The form closed without any feedback',
    'The UI remained unchanged',
    'There was no visual change',
    'No error message appeared',
  ])('detects a missing screen response in %j', (text) => {
    expect(claimsAbsence(text)).toBe(true);
  });

  it.each([
    'The response showed a validation error',
    'The loading indicator remained visible',
    'The screen changed to the billing page',
    'Clicking submit opened a confirmation dialog',
    'The user did not respond to the prompt',
    'An error message appeared below the field',
    'The UI remained on the confirmation screen',
  ])('keeps a positive screen description in %j', (text) => {
    expect(claimsAbsence(text)).toBe(false);
  });
});
