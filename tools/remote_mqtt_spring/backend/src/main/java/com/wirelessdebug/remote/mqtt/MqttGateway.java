package com.wirelessdebug.remote.mqtt;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.wirelessdebug.remote.config.AppProperties;
import com.wirelessdebug.remote.device.DeviceCommand;
import com.wirelessdebug.remote.device.DeviceService;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken;
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class MqttGateway implements MqttPublisher {
  private final AppProperties properties;
  private final DeviceService devices;
  private final ObjectMapper objectMapper;
  private MqttClient client;

  public MqttGateway(AppProperties properties, DeviceService devices, ObjectMapper objectMapper) {
    this.properties = properties;
    this.devices = devices;
    this.objectMapper = objectMapper;
  }

  @EventListener(ApplicationReadyEvent.class)
  public void start() throws Exception {
    if (!properties.getMqtt().isEnabled()) {
      return;
    }
    client = new MqttClient(
        properties.getMqtt().getUrl(),
        "wireless-debug-spring-" + UUID.randomUUID(),
        new MemoryPersistence());
    client.setCallback(new MqttCallbackExtended() {
      @Override
      public void connectComplete(boolean reconnect, String serverURI) {
        try {
          client.subscribe(topic("+", "status"), 1);
          client.subscribe(topic("+", "availability"), 1);
          client.subscribe(topic("+", "ack"), 1);
        } catch (Exception ignored) {
          // MQTT reconnect will retry subscription through connectComplete.
        }
      }

      @Override
      public void connectionLost(Throwable cause) {
      }

      @Override
      public void messageArrived(String topic, MqttMessage message) {
        handleMessage(topic, new String(message.getPayload(), StandardCharsets.UTF_8));
      }

      @Override
      public void deliveryComplete(IMqttDeliveryToken token) {
      }
    });
    MqttConnectOptions options = new MqttConnectOptions();
    options.setAutomaticReconnect(true);
    options.setCleanSession(true);
    client.connect(options);
  }

  @Override
  public void publishCommand(DeviceCommand command) {
    if (!properties.getMqtt().isEnabled() || client == null || !client.isConnected()) {
      return;
    }
    try {
      Map<String, Object> payload = Map.of(
          "command_id", command.getCommandId(),
          "type", command.getType(),
          "args", objectMapper.readValue(command.getArgsJson(), Map.class));
      MqttMessage message = new MqttMessage(objectMapper.writeValueAsBytes(payload));
      message.setQos(1);
      client.publish(topic(command.getDeviceId(), "cmd"), message);
    } catch (Exception ignored) {
      // Command remains persisted as PENDING for operator visibility.
    }
  }

  @PreDestroy
  public void stop() throws Exception {
    if (client != null && client.isConnected()) {
      client.disconnect();
    }
  }

  private void handleMessage(String topic, String payload) {
    String[] parts = topic.split("/");
    if (parts.length != 3 || !properties.getMqtt().getNamespace().equals(parts[0])) {
      return;
    }
    String deviceId = parts[1];
    String kind = parts[2];
    if ("status".equals(kind)) {
      devices.recordStatus(deviceId, payload);
    } else if ("availability".equals(kind)) {
      devices.recordAvailability(deviceId, "online".equals(payload) ? "online" : "offline");
    } else if ("ack".equals(kind)) {
      devices.recordAck(payload);
    }
  }

  private String topic(String deviceId, String suffix) {
    return properties.getMqtt().getNamespace() + "/" + deviceId + "/" + suffix;
  }
}
