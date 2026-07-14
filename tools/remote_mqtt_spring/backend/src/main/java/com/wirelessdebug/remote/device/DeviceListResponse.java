package com.wirelessdebug.remote.device;

import java.util.List;

public record DeviceListResponse(List<DeviceSummary> devices) {
}
