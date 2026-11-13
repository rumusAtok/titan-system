import { describe, expect, it } from 'vitest';
import { clearThresholdIsConsistent, evaluate, isBreach, isCleared, type RuleSpec } from './rules.js';

const high: RuleSpec = { operator: 'gt', threshold: 3.5, clear_threshold: 3.2 };
const lowBattery: RuleSpec = { operator: 'lt', threshold: 11, clear_threshold: 11.5 };
const noHysteresis: RuleSpec = { operator: 'gte', threshold: 50, clear_threshold: null };

describe('threshold comparison', () => {
  it('applies each operator at the boundary', () => {
    expect(isBreach({ operator: 'gt', threshold: 3.5 }, 3.5)).toBe(false);
    expect(isBreach({ operator: 'gt', threshold: 3.5 }, 3.51)).toBe(true);
    expect(isBreach({ operator: 'gte', threshold: 3.5 }, 3.5)).toBe(true);
    expect(isBreach({ operator: 'lt', threshold: 11 }, 11)).toBe(false);
    expect(isBreach({ operator: 'lt', threshold: 11 }, 10.99)).toBe(true);
    expect(isBreach({ operator: 'lte', threshold: 11 }, 11)).toBe(true);
  });
});

describe('alarm evaluation', () => {
  it('raises on the first breaching reading', () => {
    expect(evaluate(high, 3.9, false)).toBe('raise');
  });

  it('folds further breaching readings into the open alarm instead of raising again', () => {
    expect(evaluate(high, 4.1, true)).toBe('repeat');
    expect(evaluate(high, 3.6, true)).toBe('repeat');
  });

  it('does nothing for a normal reading with no open alarm', () => {
    expect(evaluate(high, 2.0, false)).toBe('none');
  });

  it('keeps the alarm open inside the hysteresis band and clears only past the clear threshold', () => {
    expect(evaluate(high, 3.4, true)).toBe('none');
    expect(isCleared(high, 3.4)).toBe(false);
    expect(evaluate(high, 3.2, true)).toBe('clear');
    expect(evaluate(high, 2.5, true)).toBe('clear');
  });

  it('applies hysteresis in the right direction for "below" rules', () => {
    expect(evaluate(lowBattery, 10.5, false)).toBe('raise');
    expect(evaluate(lowBattery, 11.2, true)).toBe('none');
    expect(evaluate(lowBattery, 11.5, true)).toBe('clear');
  });

  it('clears as soon as the rule stops breaching when no clear threshold is set', () => {
    expect(evaluate(noHysteresis, 49.9, true)).toBe('clear');
    expect(evaluate(noHysteresis, 50, true)).toBe('repeat');
  });
});

describe('rule consistency', () => {
  it('requires the clear threshold to be on the safe side of the trigger', () => {
    expect(clearThresholdIsConsistent(high)).toBe(true);
    expect(clearThresholdIsConsistent({ operator: 'gt', threshold: 3.5, clear_threshold: 4 })).toBe(false);
    expect(clearThresholdIsConsistent(lowBattery)).toBe(true);
    expect(clearThresholdIsConsistent({ operator: 'lt', threshold: 11, clear_threshold: 10 })).toBe(false);
    expect(clearThresholdIsConsistent(noHysteresis)).toBe(true);
  });
});
