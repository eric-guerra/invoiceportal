# InvoicePortal

Portfolio reference implementation of a 2022 project, built to show a B2B customer self-service portal: customers view invoices, see their aging, and pay one or several invoices with partial payments.

**Stack:** React 18 + TypeScript (Vite), Spring Boot 3 resource server (Java 17), PostgreSQL, Flyway, OAuth 2.0 / OIDC (Authorization Code + PKCE).

## Frontend (`frontend/`)
- **Login:** Authorization Code + **PKCE** (S256, verified against the RFC 7636 test vector).
  - `state` is checked on the callback.
  - The access token is kept in memory only, never in localStorage.
- **Invoice math** (`src/invoices.ts`):
  - All amounts are integer cents.
  - Aging buckets (current, 1–30, 31–60, 61–90, 90+) are computed per currency.
  - A payment is allocated oldest-due first, and any unapplied remainder is shown as credit on account.
  - Amount parsing doesn't drift (`"$0.1"` → 10 cents).
- **Idempotent payments:** each payment POST carries an `Idempotency-Key`, so a double-click or a retry is safe.

## Backend (`backend/`)
- **Stateless JWT resource server:**
  - `SCOPE_invoices:read` is required for reads and `SCOPE_payments:write` to pay.
  - Everything else is denied.
- **Tenant isolation:** the customer comes from the token's `customer_id` claim, never from the request.
- **Payments:**
  - One transaction covers the payment, its allocations and the invoice updates.
  - Each invoice update is guarded: it must belong to the customer, match the currency, be payable, and still owe at least that amount. Any failure rolls back the whole payment (409).
  - Idempotency uses a `(customer_id, idempotency_key)` unique constraint, including when two requests race.
  - DB `CHECK` constraints prevent overpayment even if the code has a bug.

## Run and test
```bash
cd frontend && npm install && npm test && npm run build   # 8 tests (PKCE, aging, allocation, parsing)
cd backend && mvn test                                     # MockMvc + JWT: isolation, scopes, idempotency, guards
```
