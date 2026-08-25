package com.wirelessdebug.remote.device;

import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class DeviceController {
  private final DeviceService devices;

  public DeviceController(DeviceService devices) {
    this.devices = devices;
  }

  @GetMapping("/api/devices")
  public DeviceListResponse listDevices() {
    return devices.listDevices();
  }

  @GetMapping("/api/devices/{deviceId}")
  public DeviceDetailResponse getDevice(@PathVariable String deviceId) {
    return devices.getDevice(deviceId);
  }

  @PostMapping("/api/devices/{deviceId}/commands")
  public ResponseEntity<CommandResponse> command(
      @PathVariable String deviceId,
      @Valid @RequestBody CommandRequest request,
      JwtAuthenticationToken authentication) {
    return ResponseEntity.accepted().body(devices.requestCommand(deviceId, authentication.getName(), request));
  }
}
