package com.wirelessdebug.remote.config;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")
public class AppProperties {
  private final Bootstrap bootstrap = new Bootstrap();
  private final Security security = new Security();
  private final Mqtt mqtt = new Mqtt();
  private final Cors cors = new Cors();

  public Bootstrap getBootstrap() {
    return bootstrap;
  }

  public Security getSecurity() {
    return security;
  }

  public Mqtt getMqtt() {
    return mqtt;
  }

  public Cors getCors() {
    return cors;
  }

  public static class Bootstrap {
    private String adminEmail = "admin@example.com";
    private String adminPassword = "ChangeMe123!";

    public String getAdminEmail() {
      return adminEmail;
    }

    public void setAdminEmail(String adminEmail) {
      this.adminEmail = adminEmail;
    }

    public String getAdminPassword() {
      return adminPassword;
    }

    public void setAdminPassword(String adminPassword) {
      this.adminPassword = adminPassword;
    }
  }

  public static class Security {
    private String jwtSecret = "change-me-change-me-change-me-change-me";
    private Duration tokenTtl = Duration.ofHours(8);
    private boolean cookieSecure = false;

    public String getJwtSecret() {
      return jwtSecret;
    }

    public void setJwtSecret(String jwtSecret) {
      this.jwtSecret = jwtSecret;
    }

    public Duration getTokenTtl() {
      return tokenTtl;
    }

    public void setTokenTtl(Duration tokenTtl) {
      this.tokenTtl = tokenTtl;
    }

    public boolean isCookieSecure() {
      return cookieSecure;
    }

    public void setCookieSecure(boolean cookieSecure) {
      this.cookieSecure = cookieSecure;
    }
  }

  public static class Mqtt {
    private boolean enabled = true;
    private String url = "tcp://localhost:1883";
    private String namespace = "wireless-debug";

    public boolean isEnabled() {
      return enabled;
    }

    public void setEnabled(boolean enabled) {
      this.enabled = enabled;
    }

    public String getUrl() {
      return url;
    }

    public void setUrl(String url) {
      this.url = url;
    }

    public String getNamespace() {
      return namespace;
    }

    public void setNamespace(String namespace) {
      this.namespace = namespace;
    }
  }

  public static class Cors {
    private String allowedOrigins = "http://localhost:5173,http://127.0.0.1:5173";

    public String getAllowedOrigins() {
      return allowedOrigins;
    }

    public void setAllowedOrigins(String allowedOrigins) {
      this.allowedOrigins = allowedOrigins;
    }
  }
}
