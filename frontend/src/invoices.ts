// Invoice math for the customer portal. All money is integer cents; never floats.

export type InvoiceStatus = 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'DISPUTED' | 'VOID';

export interface Invoice {
  id: string;
  number: string;
  issuedOn: string; // YYYY-MM-DD
  dueOn: string;
  currency: string;
  totalCents: number;
  paidCents: number;
  status: InvoiceStatus;
}

export const balance = (i: Invoice) => Math.max(0, i.totalCents - i.paidCents);
export const isPayable = (i: Invoice) => (i.status === 'OPEN' || i.status === 'PARTIALLY_PAID') && balance(i) > 0;

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.floor((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);

export type Bucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';
export const BUCKETS: Bucket[] = ['current', '1-30', '31-60', '61-90', '90+'];

export function bucketOf(i: Invoice, today: string): Bucket {
  const late = days(i.dueOn, today);
  if (late <= 0) return 'current';
  if (late <= 30) return '1-30';
  if (late <= 60) return '31-60';
  if (late <= 90) return '61-90';
  return '90+';
}

/** Aging summary of open balances, per currency (a customer can be billed in USD and CAD). */
export function aging(invoices: Invoice[], today: string): Record<string, Record<Bucket, number>> {
  const out: Record<string, Record<Bucket, number>> = {};
  for (const i of invoices) {
    if (!isPayable(i) && i.status !== 'DISPUTED') continue;
    const row = (out[i.currency] ??= { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 });
    row[bucketOf(i, today)] += balance(i);
  }
  return out;
}

export interface Allocation { invoiceId: string; amountCents: number }

/**
 * Spread a payment across selected invoices, oldest due date first (what AR policy requires).
 * Returns the allocations and any unapplied remainder (shown as an on-account credit warning).
 */
export function allocate(payment: number, selected: Invoice[]): { allocations: Allocation[]; unappliedCents: number } {
  if (!Number.isInteger(payment) || payment <= 0) throw new Error('payment must be a positive number of cents');
  const currencies = new Set(selected.map((i) => i.currency));
  if (currencies.size > 1) throw new Error('select invoices in a single currency');
  let left = payment;
  const allocations: Allocation[] = [];
  const ordered = selected.filter(isPayable).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.number.localeCompare(b.number));
  for (const i of ordered) {
    if (left === 0) break;
    const amt = Math.min(left, balance(i));
    allocations.push({ invoiceId: i.id, amountCents: amt });
    left -= amt;
  }
  return { allocations, unappliedCents: left };
}

/** Parse "1,234.56" / "1234.5" / "$12" into cents without float drift. */
export function parseAmount(input: string): number | null {
  const s = input.replace(/[\s,$]/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export function formatMoney(cents: number, currency: string, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}
