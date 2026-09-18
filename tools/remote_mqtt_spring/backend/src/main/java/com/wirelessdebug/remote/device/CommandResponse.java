package com.wirelessdebug.remote.device;

import java.time.Instant;

public record CommandResponse(
    String commandId,
    String deviceId,
    String type,
    String requestedBy,
    String state,
    Instant createdAt) {
}
