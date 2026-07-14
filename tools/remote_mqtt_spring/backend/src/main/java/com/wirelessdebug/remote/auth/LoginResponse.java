package com.wirelessdebug.remote.auth;

public record LoginResponse(String accessToken, UserSummary user) {
}
