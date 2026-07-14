package com.wirelessdebug.remote.auth;

import com.wirelessdebug.remote.user.UserAccount;
import com.wirelessdebug.remote.user.UserAccountRepository;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AuthController {
  private final AuthenticationManager authenticationManager;
  private final TokenService tokenService;
  private final UserAccountRepository users;

  public AuthController(
      AuthenticationManager authenticationManager,
      TokenService tokenService,
      UserAccountRepository users) {
    this.authenticationManager = authenticationManager;
    this.tokenService = tokenService;
    this.users = users;
  }

  @PostMapping("/api/auth/login")
  public ResponseEntity<LoginResponse> login(@Valid @RequestBody LoginRequest request) {
    Authentication authentication = authenticationManager.authenticate(
        new UsernamePasswordAuthenticationToken(request.email(), request.password()));
    UserAccount account = users.findByEmailIgnoreCase(authentication.getName())
        .orElseThrow();
    String token = tokenService.createAccessToken(account);
    return ResponseEntity.ok()
        .header(HttpHeaders.SET_COOKIE, tokenService.accessCookie(token).toString())
        .body(new LoginResponse(token, new UserSummary(account.getEmail(), account.getRole())));
  }

  @PostMapping("/api/auth/logout")
  public ResponseEntity<Void> logout() {
    return ResponseEntity.noContent()
        .header(HttpHeaders.SET_COOKIE, tokenService.clearCookie().toString())
        .build();
  }

  @GetMapping("/api/me")
  public UserSummary me(JwtAuthenticationToken authentication) {
    UserAccount account = users.findByEmailIgnoreCase(authentication.getName())
        .orElseThrow();
    return new UserSummary(account.getEmail(), account.getRole());
  }
}
