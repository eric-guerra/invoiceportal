CREATE TABLE invoices (
    id          VARCHAR(36) PRIMARY KEY,
    customer_id VARCHAR(20) NOT NULL,
    number      VARCHAR(20) NOT NULL UNIQUE,
    issued_on   DATE        NOT NULL,
    due_on      DATE        NOT NULL,
    currency    CHAR(3)     NOT NULL,
    total_cents BIGINT      NOT NULL CHECK (total_cents >= 0),
    paid_cents  BIGINT      NOT NULL DEFAULT 0,
    status      VARCHAR(16) NOT NULL,
    CONSTRAINT ck_paid CHECK (paid_cents >= 0 AND paid_cents <= total_cents)
);
CREATE INDEX ix_invoices_customer ON invoices (customer_id, due_on);

CREATE TABLE payments (
    id              VARCHAR(36) PRIMARY KEY,
    customer_id     VARCHAR(20) NOT NULL,
    idempotency_key VARCHAR(64) NOT NULL,
    currency        CHAR(3)     NOT NULL,
    amount_cents    BIGINT      NOT NULL CHECK (amount_cents > 0),
    created_at      TIMESTAMP   NOT NULL,
    CONSTRAINT uq_payment_idem UNIQUE (customer_id, idempotency_key)
);

CREATE TABLE payment_allocations (
    payment_id   VARCHAR(36) NOT NULL REFERENCES payments (id),
    invoice_id   VARCHAR(36) NOT NULL REFERENCES invoices (id),
    amount_cents BIGINT      NOT NULL CHECK (amount_cents > 0),
    PRIMARY KEY (payment_id, invoice_id)
);
