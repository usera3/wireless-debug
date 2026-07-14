package com.wirelessdebug.remote.device;

import jakarta.validation.constraints.NotBlank;
import java.util.Map;

public record CommandRequest(@NotBlank String type, Map<String, Object> args) {
}
