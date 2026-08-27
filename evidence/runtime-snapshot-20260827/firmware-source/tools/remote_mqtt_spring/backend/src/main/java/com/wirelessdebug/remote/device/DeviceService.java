package com.wirelessdebug.remote.device;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wirelessdebug.remote.mqtt.MqttPublisher;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class DeviceService {
  private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {
  };

  private final DeviceRepository devices;
  private final DeviceCommandRepository commands;
  private final ObjectMapper objectMapper;
  private final ObjectProvider<MqttPublisher> mqttPublisher;
  private final AtomicLong commandSeq = new AtomicLong();

  public DeviceService(
      DeviceRepository devices,
      DeviceCommandRepository commands,
      ObjectMapper objectMapper,
      ObjectProvider<MqttPublisher> mqttPublisher) {
    this.devices = devices;
    this.commands = commands;
    this.objectMapper = objectMapper;
    this.mqttPublisher = mqttPublisher;
  }

  @Transactional(readOnly = true)
  public DeviceListResponse listDevices() {
    return new DeviceListResponse(devices.findAll().stream().map(this::summary).toList());
  }

  @Transactional(readOnly = true)
  public DeviceDetailResponse getDevice(String deviceId) {
    Device device = devices.findById(deviceId).orElseGet(() -> new Device(deviceId));
    return new DeviceDetailResponse(
        summary(device),
        parseStatus(device.getStatusJson()),
        commands.findTop20ByDeviceIdOrderByCreatedAtDesc(deviceId).stream().map(this::commandResponse).toList());
  }

  @Transactional
  public CommandResponse requestCommand(String deviceId, String requestedBy, CommandRequest request) {
    Device device = devices.findById(deviceId).orElseGet(() -> devices.save(new Device(deviceId)));
    String commandId = "cmd-" + String.format("%06d", commandSeq.incrementAndGet());
    String argsJson = writeJson(request.args() == null ? Map.of() : request.args());
    DeviceCommand command = commands.save(new DeviceCommand(commandId, device.getDeviceId(), requestedBy, request.type(), argsJson));
    mqttPublisher.ifAvailable(publisher -> publisher.publishCommand(command));
    return commandResponse(command);
  }

  @Transactional
  public void recordAvailability(String deviceId, String availability) {
    Device device = devices.findById(deviceId).orElseGet(() -> devices.save(new Device(deviceId)));
    device.setAvailability(availability);
  }

  @Transactional
  public void recordStatus(String deviceId, String payload) {
    Device device = devices.findById(deviceId).orElseGet(() -> devices.save(new Device(deviceId)));
    Map<String, Object> status = parseStatus(payload);
    device.applyStatus(
        payload,
        stringValue(status.get("net_mode")),
        stringValue(status.get("ap_ip")),
        stringValue(status.get("sta_ip")),
        booleanValue(status.get("sta_connected")),
        integerValue(status.get("uart_baud")));
  }

  @Transactional
  public void recordAck(String payload) {
    Map<String, Object> ack = parseStatus(payload);
    String commandId = stringValue(ack.get("command_id"));
    if (commandId == null) {
      return;
    }
    commands.findByCommandId(commandId).ifPresent(command ->
        command.markAck(booleanValue(ack.get("ok")), stringValue(ack.get("message"))));
  }

  private DeviceSummary summary(Device device) {
    return new DeviceSummary(
        device.getDeviceId(),
        device.getAvailability(),
        device.getNetMode(),
        device.getApIp(),
        device.getStaIp(),
        device.isStaConnected(),
        device.getUartBaud(),
        device.getStatusAt(),
        device.getUpdatedAt());
  }

  private CommandResponse commandResponse(DeviceCommand command) {
    return new CommandResponse(
        command.getCommandId(),
        command.getDeviceId(),
        command.getType(),
        command.getRequestedByEmail(),
        command.getState(),
        command.getCreatedAt());
  }

  private Map<String, Object> parseStatus(String json) {
    if (json == null || json.isBlank()) {
      return Map.of();
    }
    try {
      return objectMapper.readValue(json, MAP_TYPE);
    } catch (Exception ignored) {
      return Map.of("raw", json);
    }
  }

  private String writeJson(Object value) {
    try {
      return objectMapper.writeValueAsString(value);
    } catch (Exception err) {
      throw new IllegalArgumentException("invalid command args", err);
    }
  }

  private String stringValue(Object value) {
    return value == null ? null : String.valueOf(value);
  }

  private boolean booleanValue(Object value) {
    return value instanceof Boolean bool ? bool : Boolean.parseBoolean(String.valueOf(value));
  }

  private Integer integerValue(Object value) {
    if (value instanceof Number number) {
      return number.intValue();
    }
    if (value == null) {
      return null;
    }
    try {
      return Integer.parseInt(String.valueOf(value));
    } catch (NumberFormatException err) {
      return null;
    }
  }
}
