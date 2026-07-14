package com.wirelessdebug.remote.device;

import java.util.List;
import java.util.Map;

public record DeviceDetailResponse(
    DeviceSummary device,
    Map<String, Object> status,
    List<CommandResponse> recentCommands) {
}
