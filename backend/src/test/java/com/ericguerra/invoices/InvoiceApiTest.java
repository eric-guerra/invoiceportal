package com.ericguerra.invoices;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class InvoiceApiTest {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void seed() {
        jdbc.update("DELETE FROM payment_allocations");
        jdbc.update("DELETE FROM payments");
        jdbc.update("DELETE FROM invoices");
        jdbc.update("INSERT INTO invoices VALUES ('i1','C-1','INV-1','2022-01-01','2022-02-01','USD',10000,0,'OPEN')");
        jdbc.update("INSERT INTO invoices VALUES ('i2','C-1','INV-2','2022-01-05','2022-02-05','USD',5000,4000,'PARTIALLY_PAID')");
        jdbc.update("INSERT INTO invoices VALUES ('i3','C-2','INV-3','2022-01-05','2022-02-05','USD',7000,0,'OPEN')");
    }

    MockHttpServletRequestBuilder as(MockHttpServletRequestBuilder b, String customer, String... scopes) {
        return b.with(jwt().jwt(j -> j.claim("customer_id", customer))
                .authorities(java.util.Arrays.stream(scopes).map(s -> new SimpleGrantedAuthority("SCOPE_" + s)).toArray(org.springframework.security.core.GrantedAuthority[]::new)));
    }

    MockHttpServletRequestBuilder payment(String key, String body) {
        return post("/api/payments").header("Idempotency-Key", key).contentType(MediaType.APPLICATION_JSON).content(body);
    }

    @Test
    void customersOnlySeeTheirOwnInvoices() throws Exception {
        mvc.perform(as(get("/api/invoices"), "C-1", "invoices:read"))
           .andExpect(status().isOk())
           .andExpect(jsonPath("$.length()").value(2))
           .andExpect(jsonPath("$[*].number", org.hamcrest.Matchers.containsInAnyOrder("INV-1", "INV-2")));
    }

    @Test
    void scopesAreEnforced() throws Exception {
        mvc.perform(get("/api/invoices")).andExpect(status().isUnauthorized());
        mvc.perform(as(payment("k", "{}"), "C-1", "invoices:read")).andExpect(status().isForbidden());
    }

    @Test
    void paymentAppliesAllocationsAndIsIdempotent() throws Exception {
        String body = "{\"currency\":\"USD\",\"amountCents\":6000,\"allocations\":[{\"invoiceId\":\"i2\",\"amountCents\":1000},{\"invoiceId\":\"i1\",\"amountCents\":5000}]}";
        mvc.perform(as(payment("abc", body), "C-1", "payments:write")).andExpect(status().isCreated());
        mvc.perform(as(payment("abc", body), "C-1", "payments:write")).andExpect(status().isOk()).andExpect(jsonPath("$.replayed").value(true));

        assertThat(jdbc.queryForObject("SELECT status FROM invoices WHERE id='i2'", String.class)).isEqualTo("PAID");
        assertThat(jdbc.queryForObject("SELECT paid_cents FROM invoices WHERE id='i1'", Long.class)).isEqualTo(5000L);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM payments", Integer.class)).isEqualTo(1);
    }

    @Test
    void cannotPayAnotherCustomersInvoiceOrOverpay() throws Exception {
        mvc.perform(as(payment("x1", "{\"currency\":\"USD\",\"amountCents\":100,\"allocations\":[{\"invoiceId\":\"i3\",\"amountCents\":100}]}"), "C-1", "payments:write"))
           .andExpect(status().isConflict());
        mvc.perform(as(payment("x2", "{\"currency\":\"USD\",\"amountCents\":2000,\"allocations\":[{\"invoiceId\":\"i2\",\"amountCents\":2000}]}"), "C-1", "payments:write"))
           .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM payments", Integer.class)).as("rolled back").isZero();
    }
}
