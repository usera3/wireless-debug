package com.wirelessdebug.remote.user;

import com.wirelessdebug.remote.config.AppProperties;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.password.PasswordEncoder;

@Configuration
public class BootstrapAdmin {
  @Bean
  CommandLineRunner bootstrapAdminUser(
      AppProperties properties,
      UserAccountRepository users,
      PasswordEncoder passwordEncoder) {
    return args -> users.findByEmailIgnoreCase(properties.getBootstrap().getAdminEmail())
        .orElseGet(() -> users.save(new UserAccount(
            properties.getBootstrap().getAdminEmail(),
            passwordEncoder.encode(properties.getBootstrap().getAdminPassword()),
            "ADMIN")));
  }
}
