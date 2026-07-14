package com.wirelessdebug.remote.auth;

import com.wirelessdebug.remote.config.AppProperties;
import com.wirelessdebug.remote.user.UserAccount;
import java.time.Instant;
import org.springframework.http.ResponseCookie;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.stereotype.Service;

@Service
public class TokenService {
  public static final String COOKIE_NAME = "WD_ACCESS_TOKEN";

  private final JwtEncoder jwtEncoder;
  private final AppProperties properties;

  public TokenService(JwtEncoder jwtEncoder, AppProperties properties) {
    this.jwtEncoder = jwtEncoder;
    this.properties = properties;
  }

  public String createAccessToken(UserAccount account) {
    Instant now = Instant.now();
    JwtClaimsSet claims = JwtClaimsSet.builder()
        .issuer("wireless-debug-remote")
        .issuedAt(now)
        .expiresAt(now.plus(properties.getSecurity().getTokenTtl()))
        .subject(account.getEmail())
        .claim("role", account.getRole())
        .claim("uid", account.getId().toString())
        .build();
    JwsHeader header = JwsHeader.with(MacAlgorithm.HS256).build();
    return jwtEncoder.encode(JwtEncoderParameters.from(header, claims)).getTokenValue();
  }

  public ResponseCookie accessCookie(String token) {
    return ResponseCookie.from(COOKIE_NAME, token)
        .httpOnly(true)
        .secure(properties.getSecurity().isCookieSecure())
        .sameSite("Lax")
        .path("/")
        .maxAge(properties.getSecurity().getTokenTtl())
        .build();
  }

  public ResponseCookie clearCookie() {
    return ResponseCookie.from(COOKIE_NAME, "")
        .httpOnly(true)
        .secure(properties.getSecurity().isCookieSecure())
        .sameSite("Lax")
        .path("/")
        .maxAge(0)
        .build();
  }
}
