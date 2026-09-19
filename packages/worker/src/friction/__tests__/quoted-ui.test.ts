import { describe, expect, it } from 'vitest';
import {
  extractNonGenericQuotedStrings,
  extractQuotedStrings,
  isGenericUIString,
} from '../quoted-ui.js';

describe('extractQuotedStrings', () => {
  it('extracts double-quoted strings', () => {
    const text = 'The form displays "Fill in the required fields to continue: Name, Asset Type" on save.';
    expect(extractQuotedStrings(text)).toEqual([
      'Fill in the required fields to continue: Name, Asset Type',
    ]);
  });

  it('extracts single-quoted strings', () => {
    const text = "Update button shows spurious 'required fields' validation error on asset edit form";
    expect(extractQuotedStrings(text)).toEqual(['required fields']);
  });

  it('extracts curly/smart quotes', () => {
    const text = 'Error message: “Cannot connect to server” followed by ‘Try again later’.';
    expect(extractQuotedStrings(text)).toEqual([
      'Cannot connect to server',
      'Try again later',
    ]);
  });

  it('ignores English contractions without breaking surrounding quotes', () => {
    const text = "User didn't see 'Saved' banner and user's profile wasn't updated with \"Network timeout\".";
    expect(extractQuotedStrings(text)).toEqual(['Saved', 'Network timeout']);
  });

  it('returns empty array when no quotes exist', () => {
    const text = 'Form validation reveals required fields sequentially after submission attempts';
    expect(extractQuotedStrings(text)).toEqual([]);
  });
});

describe('isGenericUIString', () => {
  it.each([
    'Loading',
    'loading...',
    'Please wait',
    'Error',
    'OK',
    'Save',
    'Submit',
    'Cancel',
    'a',
    '  ',
    '..',
  ])('classifies %j as generic', (str) => {
    expect(isGenericUIString(str)).toBe(true);
  });

  it.each([
    'Fill in the required fields to continue: Name, Asset Type',
    'required fields',
    'Asset created',
    'Invalid credit card number',
    'User with this email already exists',
  ])('classifies %j as non-generic', (str) => {
    expect(isGenericUIString(str)).toBe(false);
  });
});

describe('extractNonGenericQuotedStrings', () => {
  it('filters out generic strings while keeping specific error messages', () => {
    const texts = [
      'Button still says "Loading"',
      'Shows error "Fill in the required fields to continue: Name, Asset Type" alongside "OK"',
      'Banner says \'required fields\'',
    ];
    const result = extractNonGenericQuotedStrings(texts);
    expect(result).toEqual(
      new Set([
        'fill in the required fields to continue: name, asset type',
        'required fields',
      ]),
    );
  });

  it('returns empty set if only generic strings are present', () => {
    const texts = ['Status is "Loading"', 'Dialog says "Please wait..."'];
    expect(extractNonGenericQuotedStrings(texts)).toEqual(new Set());
  });
});
