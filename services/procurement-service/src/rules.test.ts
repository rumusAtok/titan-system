import { describe, expect, it } from 'vitest';
import { checkReceipt, isLow, lineTotal, replenishmentQuantity, requestTotal } from './rules.js';

describe('amounts', () => {
  it('adds money without binary rounding errors', () => {
    expect(lineTotal(3, 0.1)).toBe(0.3);
    expect(requestTotal([{ quantity: 3, unit_cost: 19.99 }, { quantity: 1, unit_cost: 0.01 }])).toBe(59.98);
  });
});

describe('checkReceipt', () => {
  const order = [
    { line_no: 1, quantity_ordered: 10, quantity_received: 0 },
    { line_no: 2, quantity_ordered: 4, quantity_received: 2 },
  ];

  it('accepts a partial receipt and reports the order incomplete', () => {
    expect(checkReceipt(order, [{ line_no: 1, quantity: 6 }])).toEqual({ ok: true, fully_received: false });
  });

  it('reports the order complete when every line is received', () => {
    expect(checkReceipt(order, [{ line_no: 1, quantity: 10 }, { line_no: 2, quantity: 2 }])).toEqual({ ok: true, fully_received: true });
  });

  it('refuses over-receipt, unknown or repeated lines and non-positive quantities', () => {
    expect(checkReceipt(order, [{ line_no: 2, quantity: 3 }]).ok).toBe(false);
    expect(checkReceipt(order, [{ line_no: 9, quantity: 1 }]).ok).toBe(false);
    expect(checkReceipt(order, [{ line_no: 1, quantity: 1 }, { line_no: 1, quantity: 1 }]).ok).toBe(false);
    expect(checkReceipt(order, [{ line_no: 1, quantity: 0 }]).ok).toBe(false);
    expect(checkReceipt(order, []).ok).toBe(false);
  });
});

describe('stock', () => {
  it('is low at or below the reorder level, and never for items without one', () => {
    expect(isLow(5, 5)).toBe(true);
    expect(isLow(6, 5)).toBe(false);
    expect(isLow(0, 0)).toBe(false);
  });

  it('replenishes the configured quantity, or up to twice the reorder level', () => {
    expect(replenishmentQuantity(2, 5, 20)).toBe(20);
    expect(replenishmentQuantity(2, 5, 0)).toBe(8);
  });
});


describe('sourcing and budgets', () => {
  it('totals a complete quotation and refuses incomplete or extra lines', async () => {
    const { quotationTotal } = await import('./rules.js');
    const rfq = [{ line_no: 1, quantity: 10 }, { line_no: 2, quantity: 3 }];
    expect(quotationTotal(rfq, [{ line_no: 1, unit_cost: 2.5 }, { line_no: 2, unit_cost: 0.1 }])).toEqual({ ok: true, total: 25.3 });
    expect(quotationTotal(rfq, [{ line_no: 1, unit_cost: 2.5 }]).ok).toBe(false);
    expect(quotationTotal(rfq, [{ line_no: 1, unit_cost: 1 }, { line_no: 2, unit_cost: 1 }, { line_no: 3, unit_cost: 1 }]).ok).toBe(false);
    expect(quotationTotal(rfq, [{ line_no: 1, unit_cost: 1 }, { line_no: 1, unit_cost: 1 }, { line_no: 2, unit_cost: 1 }]).ok).toBe(false);
  });

  it('says when a request would exceed the remaining budget, and never without a budget', async () => {
    const { budgetPosition } = await import('./rules.js');
    expect(budgetPosition(10000, 9000.5, 999.5)).toEqual({ available: 999.5, over: false });
    expect(budgetPosition(10000, 9000.5, 999.51)).toEqual({ available: 999.5, over: true });
    expect(budgetPosition(null, 5, 1_000_000)).toEqual({ available: null, over: false });
  });
});
