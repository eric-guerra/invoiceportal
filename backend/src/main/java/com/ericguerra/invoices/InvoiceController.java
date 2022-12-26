package com.ericguerra.invoices;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.sql.Timestamp;
import java.time.Clock;
import java.util.*;

@RestController
@RequestMapping("/api")
public class InvoiceController {
    public record Allocation(String invoiceId, long amountCents) {}
    public record PaymentReq(String currency, long amountCents, List<Allocation> allocations) {}

    private final JdbcTemplate jdbc;
    private final Clock clock;

    public InvoiceController(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    /** Tenant isolation: the customer comes from the token, never from the request. */
    static String customer(Jwt jwt) {
        String c = jwt.getClaimAsString("customer_id");
        if (c == null || c.isBlank()) throw new SecurityException("token has no customer_id");
        return c;
    }

    @GetMapping("/invoices")
    public List<Map<String, Object>> list(@AuthenticationPrincipal Jwt jwt) {
        return jdbc.queryForList("""
                SELECT id, number, issued_on AS "issuedOn", due_on AS "dueOn", currency,
                       total_cents AS "totalCents", paid_cents AS "paidCents", status
                FROM invoices WHERE customer_id = ? AND status <> 'VOID' ORDER BY due_on DESC""", customer(jwt));
    }

    @PostMapping("/payments")
    @Transactional
    public ResponseEntity<Map<String, Object>> pay(@AuthenticationPrincipal Jwt jwt,
                                                   @RequestHeader("Idempotency-Key") String key,
                                                   @RequestBody PaymentReq req) {
        String cust = customer(jwt);
        if (key.length() > 64) throw new IllegalArgumentException("Idempotency-Key too long");
        List<String> prior = jdbc.queryForList("SELECT id FROM payments WHERE customer_id = ? AND idempotency_key = ?", String.class, cust, key);
        if (!prior.isEmpty()) return ResponseEntity.ok(Map.of("paymentId", prior.get(0), "replayed", true));

        long sum = req.allocations().stream().mapToLong(Allocation::amountCents).sum();
        if (req.amountCents() <= 0 || sum > req.amountCents() || req.allocations().stream().anyMatch(a -> a.amountCents() <= 0))
            throw new IllegalArgumentException("allocations must be positive and not exceed the payment");

        String id = UUID.randomUUID().toString();
        try {
            jdbc.update("INSERT INTO payments (id, customer_id, idempotency_key, currency, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    id, cust, key, req.currency(), req.amountCents(), Timestamp.from(clock.instant()));
        } catch (DuplicateKeyException race) {
            // Concurrent retry with the same key won the insert; return its id.
            String winner = jdbc.queryForObject("SELECT id FROM payments WHERE customer_id = ? AND idempotency_key = ?", String.class, cust, key);
            return ResponseEntity.ok(Map.of("paymentId", winner, "replayed", true));
        }
        for (Allocation a : req.allocations()) {
            // Guarded update: invoice must belong to this customer, match currency and still owe at least this much.
            int n = jdbc.update("""
                    UPDATE invoices SET paid_cents = paid_cents + ?,
                           status = CASE WHEN paid_cents + ? >= total_cents THEN 'PAID' ELSE 'PARTIALLY_PAID' END
                    WHERE id = ? AND customer_id = ? AND currency = ? AND status IN ('OPEN', 'PARTIALLY_PAID')
                      AND total_cents - paid_cents >= ?""",
                    a.amountCents(), a.amountCents(), a.invoiceId(), cust, req.currency(), a.amountCents());
            if (n == 0) throw new IllegalStateException("invoice " + a.invoiceId() + " cannot accept " + a.amountCents());
            jdbc.update("INSERT INTO payment_allocations (payment_id, invoice_id, amount_cents) VALUES (?, ?, ?)", id, a.invoiceId(), a.amountCents());
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("paymentId", id, "unappliedCents", req.amountCents() - sum));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail bad(IllegalArgumentException e) { return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, e.getMessage()); }

    @ExceptionHandler(IllegalStateException.class)
    ProblemDetail conflict(IllegalStateException e) { return ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, e.getMessage()); }

    @ExceptionHandler(SecurityException.class)
    ProblemDetail forbidden(SecurityException e) { return ProblemDetail.forStatusAndDetail(HttpStatus.FORBIDDEN, e.getMessage()); }
}
