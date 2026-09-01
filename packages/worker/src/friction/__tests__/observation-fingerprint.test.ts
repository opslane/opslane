import { describe, expect, it } from 'vitest';
import { anchorIdentity, observationFingerprint } from '../fingerprint.js';

describe('observationFingerprint', () => {
  it('uses selectors only for element-anchored categories', () => {
    expect(observationFingerprint('unclickable_affordance', 'button.save', '/assets'))
      .not.toBe(observationFingerprint('unclickable_affordance', 'a.logo', '/assets'));
    expect(observationFingerprint('validation_confusion', 'button.save', '/assets'))
      .toBe(observationFingerprint('validation_confusion', 'a.logo', '/assets'));
  });

  it('canonicalizes positional selectors', () => {
    expect(observationFingerprint('no_feedback_after_action', 'div:nth-of-type(3)>button.go', '/x'))
      .toBe(observationFingerprint('no_feedback_after_action', 'div:nth-of-type(9)>button.go', '/x'));
  });

  it('keeps category as an independent fingerprint axis', () => {
    expect(observationFingerprint('slow_response', null, '/assets'))
      .not.toBe(observationFingerprint('dead_end_state', null, '/assets'));
  });
});

describe('anchorIdentity', () => {
  it('merges path variants that share a semantic class tail and leaf', () => {
    const a = 'div.assets-bottom-bar-container > div.assets-bottom-bar-filters > div.field-container > div.field-inner-container > div > div._16jlkb7n._1o9zkb7n > input._19itidpf._11c81d4k';
    const b = 'div:nth-of-type(2)._19itglyw._vchhusvi > div.bottom-bar-container > div > div.field-container > div.field-inner-container > div > div._16jlkb7n._1o9zkb7n > input._19itidpf._11c81d4k';
    expect(anchorIdentity(a)).toBe('cls:.field-inner-container>input');
    expect(anchorIdentity(b)).toBe('cls:.field-inner-container>input');
  });

  it('keeps different leaf tags under the same ancestor apart', () => {
    expect(anchorIdentity('div.toolbar > input._a1'))
      .not.toBe(anchorIdentity('div.toolbar > button._a1'));
  });

  it('uses no leaf suffix when the semantic segment is the leaf', () => {
    expect(anchorIdentity('#main > div._nd5l1gzg._1reo1wug > div.ac-content')).toBe('cls:.ac-content');
    expect(anchorIdentity('div.avatar-item-container.no-hover-styles > span'))
      .toBe('cls:.avatar-item-container.no-hover-styles>span');
  });

  it('prefers a semantic id over classes and accepts short digit runs', () => {
    expect(anchorIdentity('div.card > a#export-button._ymio1r31')).toBe('id:#export-button');
    expect(anchorIdentity('div.wizard > div#step-12')).toBe('id:#step-12');
  });

  it('never anchors on an app-shell or generated id', () => {
    expect(anchorIdentity('#main')).not.toMatch(/^id:/);
    expect(anchorIdentity('#react-select-24-option-2')).not.toMatch(/^id:/);
    expect(anchorIdentity('#ember1234567')).not.toMatch(/^id:/);
  });

  it('treats descendant and child combinators alike', () => {
    expect(anchorIdentity('form.checkout button.save'))
      .toBe(anchorIdentity('form.checkout > button.save'));
  });

  it('ignores state classes so control variants merge', () => {
    expect(anchorIdentity('button.save.disabled')).toBe(anchorIdentity('button.save'));
    expect(anchorIdentity('li.item-row.selected')).toBe(anchorIdentity('li.item-row'));
  });

  it('skips compiled atomic classes and caps the skeleton at three segments', () => {
    expect(anchorIdentity('div._1e0c1txw._vchhusvi > a._ymio1r31._ypr0glyw')).toBe('skel:div>a');
    expect(anchorIdentity('div._a1 > div._b2 > span._c3 > em._d4'))
      .toBe(anchorIdentity('section._x9 > div._a1 > div._b2 > span._c3 > em._d4'));
  });

  it('anchors unparseable selectors on the raw canonical string', () => {
    const withAttr = 'a[href="/x > y"].fancy';
    expect(anchorIdentity(withAttr)).toBe(`raw:${withAttr}`);
    expect(anchorIdentity('a[href="/x"]')).not.toBe(anchorIdentity('a[href="/y"]'));
    expect(anchorIdentity('a[href="/x"]')).toBe(anchorIdentity('a[href="/x"]'));
  });

  it('is empty for null and empty selectors', () => {
    expect(anchorIdentity(null)).toBe('');
    expect(anchorIdentity('')).toBe('');
  });

  it('ignores positional pseudo-classes', () => {
    expect(anchorIdentity('ul > li:nth-of-type(3).item-row'))
      .toBe(anchorIdentity('ul > li:nth-of-type(7).item-row'));
  });
});

describe('observationFingerprint with identity anchors', () => {
  it('merges the spike search-input pair for an element-anchored category', () => {
    const a = 'div.assets-bottom-bar-container > div.field-inner-container > input._19itidpf';
    const b = 'div.bottom-bar-container > div.field-inner-container > input._19itidpf';
    expect(observationFingerprint('no_feedback_after_action', a, '/assets'))
      .toBe(observationFingerprint('no_feedback_after_action', b, '/assets'));
  });

  it('keeps different semantic controls apart', () => {
    expect(observationFingerprint('no_feedback_after_action', 'div.field-inner-container > input', '/assets'))
      .not.toBe(observationFingerprint('no_feedback_after_action', 'div.save-bar > button.save', '/assets'));
  });
});
