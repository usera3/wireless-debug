package com.wirelessdebug.remote.device;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;

@Entity
@Table(name = "devices")
public class Device {
  @Id
  @Column(name = "device_id", nullable = false)
  private String deviceId;

  @Column(nullable = false)
  private String availability;

  @Column(name = "status_json", columnDefinition = "text")
  private String statusJson;

  @Column(name = "status_at")
  private Instant statusAt;

  @Column(name = "net_mode")
  private String netMode;

  @Column(name = "ap_ip")
  private String apIp;

  @Column(name = "sta_ip")
  private String staIp;

  @Column(name = "sta_connected", nullable = false)
  private boolean staConnected;

  @Column(name = "uart_baud")
  private Integer uartBaud;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected Device() {
  }

  public Device(String deviceId) {
    this.deviceId = deviceId;
    this.availability = "unknown";
    this.staConnected = false;
    this.updatedAt = Instant.now();
  }

  public String getDeviceId() {
    return deviceId;
  }

  public String getAvailability() {
    return availability;
  }

  public void setAvailability(String availability) {
    this.availability = availability;
    this.updatedAt = Instant.now();
  }

  public String getStatusJson() {
    return statusJson;
  }

  public Instant getStatusAt() {
    return statusAt;
  }

  public String getNetMode() {
    return netMode;
  }

  public String getApIp() {
    return apIp;
  }

  public String getStaIp() {
    return staIp;
  }

  public boolean isStaConnected() {
    return staConnected;
  }

  public Integer getUartBaud() {
    return uartBaud;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  public void applyStatus(String statusJson, String netMode, String apIp, String staIp, boolean staConnected, Integer uartBaud) {
    this.statusJson = statusJson;
    this.statusAt = Instant.now();
    this.availability = "online";
    this.netMode = netMode;
    this.apIp = apIp;
    this.staIp = staIp;
    this.staConnected = staConnected;
    this.uartBaud = uartBaud;
    this.updatedAt = Instant.now();
  }
}
