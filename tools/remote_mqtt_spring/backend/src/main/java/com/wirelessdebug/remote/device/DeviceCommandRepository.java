package com.wirelessdebug.remote.device;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface DeviceCommandRepository extends JpaRepository<DeviceCommand, UUID> {
  Optional<DeviceCommand> findByCommandId(String commandId);

  List<DeviceCommand> findTop20ByDeviceIdOrderByCreatedAtDesc(String deviceId);
}
