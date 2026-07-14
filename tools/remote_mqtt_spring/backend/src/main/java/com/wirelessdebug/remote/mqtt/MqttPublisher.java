package com.wirelessdebug.remote.mqtt;

import com.wirelessdebug.remote.device.DeviceCommand;

public interface MqttPublisher {
  void publishCommand(DeviceCommand command);
}
