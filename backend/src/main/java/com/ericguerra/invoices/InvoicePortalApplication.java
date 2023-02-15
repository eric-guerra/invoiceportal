package com.ericguerra.invoices;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

import java.time.Clock;

@SpringBootApplication
@EnableMethodSecurity
public class InvoicePortalApplication {
    public static void main(String[] args) {
        SpringApplication.run(InvoicePortalApplication.class, args);
    }

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }

    /** Stateless resource server: every request carries a JWT; scopes gate read vs pay. */
    @Bean
    SecurityFilterChain api(HttpSecurity http) throws Exception {
        http.csrf(c -> c.disable()) // bearer tokens, no cookies → CSRF not applicable
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(a -> a
                .requestMatchers(HttpMethod.GET, "/api/invoices/**").hasAuthority("SCOPE_invoices:read")
                .requestMatchers(HttpMethod.POST, "/api/payments").hasAuthority("SCOPE_payments:write")
                .anyRequest().denyAll())
            .oauth2ResourceServer(o -> o.jwt());
        return http.build();
    }
}
