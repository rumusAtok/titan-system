/** Pure threshold-rule evaluation. No I/O. */

export type Operator = 'gt' | 'gte' | 'lt' | 'lte';

export interface RuleSpec {
  operator: Operator;
  threshold: number;
  /** Optional hysteresis level; see `isCleared`. */
  clear_threshold: number | null;
}

export function isBreach(rule: Pick<RuleSpec, 'operator' | 'threshold'>, value: number): boolean {
  switch (rule.operator) {
    case 'gt':
      return value > rule.threshold;
    case 'gte':
      return value >= rule.threshold;
    case 'lt':
      return value < rule.threshold;
    case 'lte':
      return value <= rule.threshold;
  }
}

/**
 * Whether an open alarm may clear at this value.
 * Without a clear threshold the alarm clears as soon as the rule no longer
 * breaches. With one, the value must come all the way back past it, which
 * stops an alarm from flapping while the reading hovers around the threshold.
 */
export function isCleared(rule: RuleSpec, value: number): boolean {
  if (isBreach(rule, value)) return false;
  if (rule.clear_threshold === null) return true;
  return rule.operator === 'gt' || rule.operator === 'gte' ? value <= rule.clear_threshold : value >= rule.clear_threshold;
}

export type Evaluation = 'raise' | 'repeat' | 'clear' | 'none';

/** What a reading means for a rule, given whether an alarm is already open for it. */
export function evaluate(rule: RuleSpec, value: number, hasOpenAlert: boolean): Evaluation {
  if (isBreach(rule, value)) return hasOpenAlert ? 'repeat' : 'raise';
  if (hasOpenAlert && isCleared(rule, value)) return 'clear';
  return 'none';
}

/** A clear threshold must sit on the safe side of the trigger threshold. */
export function clearThresholdIsConsistent(rule: RuleSpec): boolean {
  if (rule.clear_threshold === null) return true;
  return rule.operator === 'gt' || rule.operator === 'gte' ? rule.clear_threshold <= rule.threshold : rule.clear_threshold >= rule.threshold;
}

export const OPERATOR_SYMBOL: Record<Operator, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
