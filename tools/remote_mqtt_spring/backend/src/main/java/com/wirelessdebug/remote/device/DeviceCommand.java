package com.wirelessdebug.remote.device;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "device_commands")
public class DeviceCommand {
  @Id
  private UUID id;

  @Column(name = "command_id", nullable = false, unique = true)
  private String commandId;

  @Column(name = "device_id", nullable = false)
  private String deviceId;

  @Column(name = "requested_by_email", nullable = false)
  private String requestedByEmail;

  @Column(nullable = false)
  private String type;

  @Column(name = "args_json", nullable = false, columnDefinition = "text")
  private String argsJson;

  @Column(nullable = false)
  private String state;

  @Column(name = "ack_ok")
  private Boolean ackOk;

  @Column(name = "ack_message", columnDefinition = "text")
  private String ackMessage;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "ack_at")
  private Instant ackAt;

  protected DeviceCommand() {
  }

  public DeviceCommand(String commandId, String deviceId, String requestedByEmail, String type, String argsJson) {
    this.id = UUID.randomUUID();
    this.commandId = commandId;
    this.deviceId = deviceId;
    this.requestedByEmail = requestedByEmail;
    this.type = type;
    this.argsJson = argsJson;
    this.state = "PENDING";
    this.createdAt = Instant.now();
  }

  public String getCommandId() {
    return commandId;
  }

  public String getDeviceId() {
    return deviceId;
  }

  public String getRequestedByEmail() {
    return requestedByEmail;
  }

  public String getType() {
    return type;
  }

  public String getArgsJson() {
    return argsJson;
  }

  public String getState() {
    return state;
  }

  public Boolean getAckOk() {
    return ackOk;
  }

  public String getAckMessage() {
    return ackMessage;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getAckAt() {
    return ackAt;
  }

  public void markAck(Boolean ok, String message) {
    this.state = Boolean.TRUE.equals(ok) ? "ACKED" : "FAILED";
    this.ackOk = ok;
    this.ackMessage = message;
    this.ackAt = Instant.now();
  }
}
