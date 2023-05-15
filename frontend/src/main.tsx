import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { aging, allocate, balance, BUCKETS, formatMoney, Invoice, isPayable, parseAmount } from './invoices';
import { beginLogin, completeLogin } from './auth';

const cfg = {
  issuer: import.meta.env.VITE_ISSUER ?? 'http://localhost:9000',
  clientId: 'invoice-portal',
  redirectUri: `${location.origin}/callback`,
  scope: 'openid invoices:read payments:write',
};

let accessToken: string | null = null; // memory only

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });
  if (res.status === 401) { await login(); throw new Error('session expired'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? res.statusText);
  return res.json();
}

async function login() {
  const { url, pending } = await beginLogin(cfg, location.pathname);
  sessionStorage.setItem('pkce', JSON.stringify(pending)); // verifier must survive the redirect; it's single-use
  location.assign(url);
}

function App() {
  const [ready, setReady] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    (async () => {
      if (location.pathname === '/callback') {
        const pending = JSON.parse(sessionStorage.getItem('pkce') ?? '{}');
        sessionStorage.removeItem('pkce');
        accessToken = (await completeLogin(cfg, location.href, pending)).accessToken;
        history.replaceState(null, '', pending.returnTo ?? '/');
      }
      if (!accessToken) return login();
      setInvoices(await api<Invoice[]>('/invoices'));
      setReady(true);
    })().catch((e) => setMessage(e.message));
  }, []);

  const chosen = invoices.filter((i) => selected.has(i.id));
  const selectedBalance = chosen.reduce((s, i) => s + balance(i), 0);
  const summary = useMemo(() => aging(invoices, today), [invoices, today]);
  const cents = parseAmount(amount || String(selectedBalance / 100));
  let preview: ReturnType<typeof allocate> | null = null;
  try { if (cents && chosen.length) preview = allocate(cents, chosen); } catch (e) { /* shown below */ }

  async function pay() {
    if (!preview) return;
    try {
      const r = await api<{ paymentId: string }>('/payments', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ currency: chosen[0].currency, amountCents: cents, allocations: preview.allocations }),
      });
      setMessage(`Payment ${r.paymentId} submitted`);
      setSelected(new Set());
      setInvoices(await api<Invoice[]>('/invoices'));
    } catch (e) { setMessage((e as Error).message); }
  }

  if (!ready) return <p>{message ?? 'Signing in…'}</p>;
  return (
    <main>
      <h1>Invoices</h1>
      {Object.entries(summary).map(([cur, row]) => (
        <table key={cur} className="aging"><tbody><tr>
          <th>{cur}</th>{BUCKETS.map((b) => <td key={b}><small>{b}</small><br />{formatMoney(row[b], cur)}</td>)}
        </tr></tbody></table>
      ))}
      <table>
        <thead><tr><th /><th>Invoice</th><th>Due</th><th>Total</th><th>Balance</th><th>Status</th></tr></thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <td><input type="checkbox" disabled={!isPayable(i)} checked={selected.has(i.id)}
                onChange={(e) => { const s = new Set(selected); e.target.checked ? s.add(i.id) : s.delete(i.id); setSelected(s); }} /></td>
              <td><a href={`/api/invoices/${i.id}/pdf`}>{i.number}</a></td>
              <td>{i.dueOn}</td>
              <td>{formatMoney(i.totalCents, i.currency)}</td>
              <td>{formatMoney(balance(i), i.currency)}</td>
              <td>{i.status.replace('_', ' ').toLowerCase()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {chosen.length > 0 && (
        <section>
          <label>Amount <input value={amount} placeholder={(selectedBalance / 100).toFixed(2)} onChange={(e) => setAmount(e.target.value)} /></label>
          {preview?.unappliedCents ? <p>{formatMoney(preview.unappliedCents, chosen[0].currency)} would be left as credit on account.</p> : null}
          <button disabled={!preview} onClick={pay}>Pay {cents ? formatMoney(cents, chosen[0].currency) : ''}</button>
        </section>
      )}
      {message && <p role="status">{message}</p>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
