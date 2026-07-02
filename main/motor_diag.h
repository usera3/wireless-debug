#ifndef MOTOR_DIAG_H
#define MOTOR_DIAG_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define MOTOR_DIAG_DEFAULT_SLAVE_ID 0xFFU
#define MOTOR_DIAG_FUNC_READ_HOLDING 0x03U
#define MOTOR_DIAG_FUNC_READ_INPUT 0x04U
#define MOTOR_DIAG_FUNC_WRITE_SINGLE 0x06U
#define MOTOR_DIAG_FUNC_HEARTBEAT 0x08U
#define MOTOR_DIAG_FUNC_WRITE_MULTI 0x10U
#define MOTOR_DIAG_FUNC_OSC_START 0x71U
#define MOTOR_DIAG_FUNC_OSC_STOP 0x72U
#define MOTOR_DIAG_FUNC_OSC_RATE 0x73U
#define MOTOR_DIAG_FUNC_OSC_CHANNEL 0x75U
#define MOTOR_DIAG_OSC_QUERY_FRAME_LEN 0U
#define MOTOR_DIAG_OSC_QUERY_MAX_CHANNELS 1U
#define MOTOR_DIAG_OSC_QUERY_SAMPLE_RATE 2U
#define MOTOR_DIAG_MAX_FRAME_LEN 256U
#define MOTOR_DIAG_MAX_PARAMS 96U
#define MOTOR_DIAG_ALIAS_MAX 32U
#define MOTOR_DIAG_UNIT_MAX 16U

typedef struct {
    uint8_t data[MOTOR_DIAG_MAX_FRAME_LEN];
    size_t len;
} motor_diag_frame_t;

typedef struct {
    char alias[MOTOR_DIAG_ALIAS_MAX];
    char unit[MOTOR_DIAG_UNIT_MAX];
    uint16_t address;
    uint8_t decimals;
    bool signed_value;
    bool is_float;
    bool read_only;
    bool has_min;
    bool has_max;
    double min;
    double max;
} motor_diag_param_t;

uint16_t motor_diag_crc16_modbus(const uint8_t *data, size_t len);

esp_err_t motor_diag_build_read(uint8_t slave_id, uint16_t address,
                                uint16_t count, motor_diag_frame_t *out);
esp_err_t motor_diag_build_write_u16(uint8_t slave_id, uint16_t address,
                                     uint16_t value, motor_diag_frame_t *out);
esp_err_t motor_diag_build_write_i16(uint8_t slave_id, uint16_t address,
                                     int16_t value, motor_diag_frame_t *out);
esp_err_t motor_diag_build_write_scaled(uint8_t slave_id, uint16_t address,
                                        double value, uint8_t decimals,
                                        bool signed_value,
                                        int32_t *raw_value,
                                        motor_diag_frame_t *out);
esp_err_t motor_diag_build_write_float32(uint8_t slave_id, uint16_t address,
                                         float value, motor_diag_frame_t *out);
esp_err_t motor_diag_build_write_words(uint8_t slave_id, uint16_t address,
                                       const uint16_t *words, size_t word_count,
                                       motor_diag_frame_t *out);
esp_err_t motor_diag_build_osc_query(uint8_t slave_id, uint16_t item,
                                     motor_diag_frame_t *out);
esp_err_t motor_diag_build_osc_set_channel(uint8_t slave_id, uint8_t channel,
                                           uint8_t param_type,
                                           uint16_t address,
                                           motor_diag_frame_t *out);
esp_err_t motor_diag_build_osc_start(uint8_t slave_id, motor_diag_frame_t *out);
esp_err_t motor_diag_build_osc_stop(uint8_t slave_id, motor_diag_frame_t *out);
esp_err_t motor_diag_build_osc_heartbeat(uint8_t slave_id,
                                         motor_diag_frame_t *out);
esp_err_t motor_diag_build_osc_rate(uint8_t slave_id, uint32_t bytes_per_sec,
                                    motor_diag_frame_t *out);

esp_err_t motor_diag_hex_encode(const uint8_t *data, size_t len,
                                char *out, size_t out_size);

esp_err_t motor_diag_param_register(const motor_diag_param_t *param);
bool motor_diag_param_find(const char *alias, motor_diag_param_t *out);
bool motor_diag_param_find_in_text(const char *text, motor_diag_param_t *out);
size_t motor_diag_param_snapshot(motor_diag_param_t *out, size_t capacity);
size_t motor_diag_param_count(void);
size_t motor_diag_param_capacity(void);
void motor_diag_param_clear(void);

esp_err_t motor_diag_build_param_read(const motor_diag_param_t *param,
                                      uint8_t slave_id,
                                      motor_diag_frame_t *out);
esp_err_t motor_diag_build_param_write(const motor_diag_param_t *param,
                                       uint8_t slave_id, double value,
                                       int32_t *raw_value,
                                       motor_diag_frame_t *out);

#endif /* MOTOR_DIAG_H */
