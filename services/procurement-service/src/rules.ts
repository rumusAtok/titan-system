/** Pure procurement rules (no I/O). Amounts are handled in cents to avoid binary rounding. */

export function toCents(value: number): number {
  return Math.round(value * 100);
}

export function lineTotal(quantity: number, unitCost: number): number {
  return toCents(quantity * unitCost) / 100;
}

export function requestTotal(lines: { quantity: number; unit_cost: number }[]): number {
  return lines.reduce((sum, l) => sum + toCents(l.quantity * l.unit_cost), 0) / 100;
}

export type ReceiptCheck = { ok: true; fully_received: boolean } | { ok: false; reason: string };

/**
 * Validates a goods receipt against the order: only lines of the order, positive
 * quantities, never more than is still outstanding. Returns whether the order is
 * complete afterwards.
 */
export function checkReceipt(
  orderLines: { line_no: number; quantity_ordered: number; quantity_received: number }[],
  receipt: { line_no: number; quantity: number }[],
): ReceiptCheck {
  if (receipt.length === 0) return { ok: false, reason: 'a receipt needs at least one line' };
  const seen = new Set<number>();
  const after = new Map(orderLines.map((l) => [l.line_no, l.quantity_received]));
  for (const r of receipt) {
    const line = orderLines.find((l) => l.line_no === r.line_no);
    if (!line) return { ok: false, reason: `line ${r.line_no} is not on the order` };
    if (seen.has(r.line_no)) return { ok: false, reason: `line ${r.line_no} is listed twice` };
    seen.add(r.line_no);
    if (!(r.quantity > 0)) return { ok: false, reason: `line ${r.line_no}: quantity must be positive` };
    const outstanding = line.quantity_ordered - line.quantity_received;
    if (r.quantity > outstanding) return { ok: false, reason: `line ${r.line_no}: ${r.quantity} received but only ${outstanding} outstanding` };
    after.set(r.line_no, line.quantity_received + r.quantity);
  }
  return { ok: true, fully_received: orderLines.every((l) => (after.get(l.line_no) ?? 0) >= l.quantity_ordered) };
}

/** Low when at or below the reorder level, for items that have one. */
export function isLow(onHand: number, reorderLevel: number): boolean {
  return reorderLevel > 0 && onHand <= reorderLevel;
}

/** Replenishment quantity: the configured quantity, or enough to reach twice the reorder level. */
export function replenishmentQuantity(onHand: number, reorderLevel: number, reorderQuantity: number): number {
  if (reorderQuantity > 0) return reorderQuantity;
  return Math.max(1, 2 * reorderLevel - onHand);
}


/** A quotation must price every line of the request for quotation, once, and nothing else. */
export function quotationTotal(
  rfqLines: { line_no: number; quantity: number }[],
  quoted: { line_no: number; unit_cost: number }[],
): { ok: true; total: number } | { ok: false; reason: string } {
  const seen = new Set<number>();
  for (const q of quoted) {
    if (seen.has(q.line_no)) return { ok: false, reason: `line ${q.line_no} is priced twice` };
    seen.add(q.line_no);
    if (!rfqLines.some((l) => l.line_no === q.line_no)) return { ok: false, reason: `line ${q.line_no} is not in the request for quotation` };
    if (!(q.unit_cost >= 0)) return { ok: false, reason: `line ${q.line_no} needs a unit cost of 0 or more` };
  }
  const missing = rfqLines.filter((l) => !seen.has(l.line_no)).map((l) => l.line_no);
  if (missing.length) return { ok: false, reason: `line(s) ${missing.join(', ')} not priced` };
  return { ok: true, total: requestTotal(quoted.map((q) => ({ quantity: Number(rfqLines.find((l) => l.line_no === q.line_no)!.quantity), unit_cost: q.unit_cost }))) };
}

/** Budget position of a cost centre if `amount` were committed on top of what already is. */
export function budgetPosition(budget: number | null, committed: number, amount: number): { available: number | null; over: boolean } {
  if (budget === null) return { available: null, over: false };
  const available = (toCents(budget) - toCents(committed)) / 100;
  return { available, over: toCents(amount) > toCents(available) };
}
