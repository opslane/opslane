import { describe, it, expect } from 'vitest';
import { frictionFingerprint, normalizePageUrl } from '../fingerprint.js';

describe('frictionFingerprint positional normalization', () => {
  it('collapses nth-of-type variants of the same element into one bucket', () => {
    const a = frictionFingerprint(
      'dead_click',
      'div:nth-of-type(4) > div.field-container.has-label',
      'https://app.example.com/assets',
    );
    const b = frictionFingerprint(
      'dead_click',
      'div:nth-of-type(3) > div.field-container.has-label',
      'https://app.example.com/assets',
    );
    expect(a).toBe(b);
  });

  it('collapses nth-child variants of the same element into one bucket', () => {
    const a = frictionFingerprint('rage_click', 'ul > li:nth-child(2) > button.save', '/x');
    const b = frictionFingerprint('rage_click', 'ul > li:nth-child(9) > button.save', '/x');
    expect(a).toBe(b);
  });

  it('keeps genuinely different elements in different buckets', () => {
    const save = frictionFingerprint('dead_click', 'div:nth-of-type(4) > button.save', '/x');
    const cancel = frictionFingerprint('dead_click', 'div:nth-of-type(4) > button.cancel', '/x');
    expect(save).not.toBe(cancel);
  });

  it('keeps the existing react-select canonicalization', () => {
    const a = frictionFingerprint('dead_click', '#react-select-3-option-1', '/x');
    const b = frictionFingerprint('dead_click', '#react-select-3-option-7', '/x');
    expect(a).toBe(b);
  });

  it('does not alter whitespace inside quoted attribute values', () => {
    const a = frictionFingerprint('dead_click', 'input[placeholder="First  Name"]', '/x');
    const b = frictionFingerprint('dead_click', 'input[placeholder="First Name"]', '/x');
    expect(a).not.toBe(b);
  });

  it('still separates signal types and pages', () => {
    expect(frictionFingerprint('dead_click', 'button.x', '/a'))
      .not.toBe(frictionFingerprint('rage_click', 'button.x', '/a'));
    expect(frictionFingerprint('dead_click', 'button.x', '/a'))
      .not.toBe(frictionFingerprint('dead_click', 'button.x', '/b'));
  });

  it('treats a null selector as an empty selector', () => {
    expect(frictionFingerprint('dead_click', null, '/x'))
      .toBe(frictionFingerprint('dead_click', '', '/x'));
  });

  it('keeps one identity across origin rotations but separates pages', () => {
    const first = frictionFingerprint(
      'dead_click',
      '#save',
      normalizePageUrl('https://a.cdn.test/checkout'),
    );
    const rotated = frictionFingerprint(
      'dead_click',
      '#save',
      normalizePageUrl('https://b.cdn.test/checkout'),
    );
    const otherPage = frictionFingerprint(
      'dead_click',
      '#save',
      normalizePageUrl('https://b.cdn.test/orders'),
    );

    expect(first).toBe(rotated);
    expect(first).not.toBe(otherPage);
  });
});
