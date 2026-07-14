package com.wirelessdebug.remote.device;

import java.time.Instant;

public record DeviceSummary(
    String deviceId,
    String availability,
    String netMode,
    String apIp,
    String staIp,
    boolean staConnected,
    Integer uartBaud,
    Instant statusAt,
    Instant updatedAt) {
}
