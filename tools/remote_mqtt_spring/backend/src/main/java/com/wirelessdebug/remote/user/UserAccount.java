package com.wirelessdebug.remote.user;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "user_accounts")
public class UserAccount {
  @Id
  private UUID id;

  @Column(nullable = false, unique = true)
  private String email;

  @Column(name = "password_hash", nullable = false)
  private String passwordHash;

  @Column(nullable = false)
  private String role;

  @Column(nullable = false)
  private boolean enabled;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  protected UserAccount() {
  }

  public UserAccount(String email, String passwordHash, String role) {
    this.id = UUID.randomUUID();
    this.email = email.toLowerCase();
    this.passwordHash = passwordHash;
    this.role = role;
    this.enabled = true;
    this.createdAt = Instant.now();
  }

  public UUID getId() {
    return id;
  }

  public String getEmail() {
    return email;
  }

  public String getPasswordHash() {
    return passwordHash;
  }

  public String getRole() {
    return role;
  }

  public boolean isEnabled() {
    return enabled;
  }
}
