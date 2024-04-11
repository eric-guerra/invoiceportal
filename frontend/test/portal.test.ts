import { describe, it, expect, vi } from 'vitest';
import { aging, allocate, balance, bucketOf, parseAmount, formatMoney, Invoice } from '../src/invoices';
import { beginLogin, challengeFor, completeLogin, decodeClaims } from '../src/auth';

const inv = (id: string, dueOn: string, total: number, paid = 0, extra: Partial<Invoice> = {}): Invoice => ({
  id, number: `INV-${id}`, issuedOn: '2022-01-01', dueOn, currency: 'USD', totalCents: total, paidCents: paid,
  status: paid > 0 ? 'PARTIALLY_PAID' : 'OPEN', ...extra,
});

describe('invoices', () => {
  it('buckets by days past due', () => {
    const today = '2022-06-30';
    expect(bucketOf(inv('a', '2022-07-01', 1), today)).toBe('current');
    expect(bucketOf(inv('a', '2022-06-30', 1), today)).toBe('current');
    expect(bucketOf(inv('a', '2022-05-31', 1), today)).toBe('1-30');
    expect(bucketOf(inv('a', '2022-05-30', 1), today)).toBe('31-60');
    expect(bucketOf(inv('a', '2022-03-01', 1), today)).toBe('90+');
  });

  it('aging sums open balances per currency and skips paid/void', () => {
    const a = aging([
      inv('1', '2022-06-01', 10000, 2500),
      inv('2', '2022-07-15', 5000),
      inv('3', '2022-01-01', 9999, 9999, { status: 'PAID' }),
      inv('4', '2022-06-01', 700, 0, { currency: 'CAD' }),
      inv('5', '2022-04-01', 300, 0, { status: 'DISPUTED' }),
    ], '2022-06-30');
    expect(a.USD).toEqual({ current: 5000, '1-30': 7500, '31-60': 0, '61-90': 300, '90+': 0 });
    expect(a.CAD['1-30']).toBe(700);
  });

  it('allocates oldest-due first and reports unapplied remainder', () => {
    const list = [inv('new', '2022-07-01', 5000), inv('old', '2022-05-01', 3000, 1000), inv('mid', '2022-06-01', 1000)];
    expect(allocate(2500, list)).toEqual({ allocations: [{ invoiceId: 'old', amountCents: 2000 }, { invoiceId: 'mid', amountCents: 500 }], unappliedCents: 0 });
    expect(allocate(10000, list).unappliedCents).toBe(2000);
    expect(() => allocate(1.5, list)).toThrow();
    expect(() => allocate(100, [inv('a', '2022-01-01', 1), inv('b', '2022-01-01', 1, 0, { currency: 'CAD' })])).toThrow(/single currency/);
    expect(balance(inv('x', '2022-01-01', 100, 150))).toBe(0);
  });

  it('parses amounts without float drift', () => {
    expect(parseAmount('1,234.56')).toBe(123456);
    expect(parseAmount('$0.1')).toBe(10);
    expect(parseAmount('19.99')).toBe(1999);
    expect(parseAmount('12')).toBe(1200);
    expect(parseAmount('1.234')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
    expect(formatMoney(123456, 'USD')).toBe('$1,234.56');
  });
});

describe('PKCE auth', () => {
  it('produces the RFC 7636 S256 challenge', async () => {
    // Appendix B test vector
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  const cfg = { issuer: 'https://auth.example.com', clientId: 'portal', redirectUri: 'https://portal.example.com/callback', scope: 'openid invoices:read payments:write' };

  it('builds an authorize URL with state and challenge', async () => {
    const { url, pending } = await beginLogin(cfg);
    const q = new URL(url).searchParams;
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBe(await challengeFor(pending.verifier));
    expect(q.get('state')).toBe(pending.state);
    expect(pending.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('rejects state mismatch and exchanges the code with the verifier', async () => {
    const pending = { verifier: 'v'.repeat(50), state: 'abc' };
    await expect(completeLogin(cfg, `${cfg.redirectUri}?code=x&state=evil`, pending)).rejects.toThrow('state mismatch');
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      const body = new URLSearchParams(init.body);
      expect(body.get('code_verifier')).toBe(pending.verifier);
      expect(body.get('code')).toBe('the-code');
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 60 }), { status: 200 });
    });
    const t = await completeLogin(cfg, `${cfg.redirectUri}?code=the-code&state=abc`, pending, fetchImpl as any);
    expect(t.accessToken).toBe('tok');
    await expect(completeLogin(cfg, `${cfg.redirectUri}?error=access_denied&state=abc`, pending)).rejects.toThrow('access_denied');
  });

  it('decodes JWT claims for display', () => {
    const payload = btoa(JSON.stringify({ sub: 'u1', customer_id: 'C-77' })).replace(/=+$/, '');
    expect(decodeClaims(`h.${payload}.s`)).toEqual({ sub: 'u1', customer_id: 'C-77' });
  });
});
