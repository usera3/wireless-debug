#include "motor_diag.h"

#include <string.h>

#include "freertos/FreeRTOS.h"

static motor_diag_param_t s_params[MOTOR_DIAG_MAX_PARAMS];
static size_t s_param_count;
static portMUX_TYPE s_param_lock = portMUX_INITIALIZER_UNLOCKED;

static char ascii_lower_char(char c)
{
    if (c >= 'A' && c <= 'Z') {
        return (char)(c - 'A' + 'a');
    }
    return c;
}

static bool ascii_word_char(char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9') || c == '_';
}

static bool alias_equal(const char *a, const char *b)
{
    if (a == NULL || b == NULL) {
        return false;
    }
    while (*a != '\0' && *b != '\0') {
        if (ascii_lower_char(*a) != ascii_lower_char(*b)) {
            return false;
        }
        a++;
        b++;
    }
    return *a == '\0' && *b == '\0';
}

static bool alias_match_at(const char *text, const char *alias, size_t alias_len)
{
    for (size_t i = 0; i < alias_len; i++) {
        if (ascii_lower_char(text[i]) != ascii_lower_char(alias[i])) {
            return false;
        }
    }
    char before = '\0';
    char after = text[alias_len];
    return !ascii_word_char(before) && !ascii_word_char(after);
}

static bool text_contains_alias(const char *text, const char *alias)
{
    if (text == NULL || alias == NULL || alias[0] == '\0') {
        return false;
    }

    size_t alias_len = strlen(alias);
    for (const char *p = text; *p != '\0'; p++) {
        if (p != text && ascii_word_char(p[-1])) {
            continue;
        }
        if (alias_match_at(p, alias, alias_len)) {
            return true;
        }
    }
    return false;
}

uint16_t motor_diag_crc16_modbus(const uint8_t *data, size_t len)
{
    uint16_t crc = 0xFFFFU;

    if (data == NULL) {
        return crc;
    }

    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (uint8_t bit = 0; bit < 8; bit++) {
            if ((crc & 1U) != 0U) {
                crc = (uint16_t)((crc >> 1U) ^ 0xA001U);
            } else {
                crc = (uint16_t)(crc >> 1U);
            }
        }
    }
    return crc;
}

static esp_err_t finish_frame(motor_diag_frame_t *out, size_t payload_len)
{
    if (out == NULL || payload_len + 2U > sizeof(out->data)) {
        return ESP_ERR_INVALID_ARG;
    }

    uint16_t crc = motor_diag_crc16_modbus(out->data, payload_len);
    out->data[payload_len] = (uint8_t)(crc & 0xFFU);
    out->data[payload_len + 1U] = (uint8_t)((crc >> 8U) & 0xFFU);
    out->len = payload_len + 2U;
    return ESP_OK;
}

esp_err_t motor_diag_build_read(uint8_t slave_id, uint16_t address,
                                uint16_t count, motor_diag_frame_t *out)
{
    if (out == NULL || count == 0U || count > 125U) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out, 0, sizeof(*out));
    out->data[0] = slave_id;
    out->data[1] = MOTOR_DIAG_FUNC_READ_HOLDING;
    out->data[2] = (uint8_t)(address >> 8U);
    out->data[3] = (uint8_t)(address & 0xFFU);
    out->data[4] = (uint8_t)(count >> 8U);
    out->data[5] = (uint8_t)(count & 0xFFU);
    return finish_frame(out, 6U);
}

esp_err_t motor_diag_build_write_u16(uint8_t slave_id, uint16_t address,
                                     uint16_t value, motor_diag_frame_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out, 0, sizeof(*out));
    out->data[0] = slave_id;
    out->data[1] = MOTOR_DIAG_FUNC_WRITE_SINGLE;
    out->data[2] = (uint8_t)(address >> 8U);
    out->data[3] = (uint8_t)(address & 0xFFU);
    out->data[4] = (uint8_t)(value >> 8U);
    out->data[5] = (uint8_t)(value & 0xFFU);
    return finish_frame(out, 6U);
}

esp_err_t motor_diag_build_write_i16(uint8_t slave_id, uint16_t address,
                                     int16_t value, motor_diag_frame_t *out)
{
    return motor_diag_build_write_u16(slave_id, address, (uint16_t)value, out);
}

esp_err_t motor_diag_build_write_scaled(uint8_t slave_id, uint16_t address,
                                        double value, uint8_t decimals,
                                        bool signed_value,
                                        int32_t *raw_value,
                                        motor_diag_frame_t *out)
{
    double scale = 1.0;

    if (decimals > 9U) {
        return ESP_ERR_INVALID_ARG;
    }

    for (uint8_t i = 0; i < decimals; i++) {
        scale *= 10.0;
    }

    double scaled = value * scale;
    int32_t raw = (int32_t)(scaled >= 0.0 ? scaled + 0.5 : scaled - 0.5);

    if (signed_value) {
        if (raw < -32768 || raw > 32767) {
            return ESP_ERR_INVALID_SIZE;
        }
    } else if (raw < 0 || raw > 65535) {
        return ESP_ERR_INVALID_SIZE;
    }

    if (raw_value != NULL) {
        *raw_value = raw;
    }
    return motor_diag_build_write_u16(slave_id, address, (uint16_t)raw, out);
}

esp_err_t motor_diag_build_write_float32(uint8_t slave_id, uint16_t address,
                                         float value, motor_diag_frame_t *out)
{
    union {
        float f;
        uint32_t u;
    } bits = {
        .f = value,
    };
    uint16_t words[2] = {
        (uint16_t)((bits.u >> 16U) & 0xFFFFU),
        (uint16_t)(bits.u & 0xFFFFU),
    };

    return motor_diag_build_write_words(slave_id, address, words, 2U, out);
}

esp_err_t motor_diag_build_write_words(uint8_t slave_id, uint16_t address,
                                       const uint16_t *words, size_t word_count,
                                       motor_diag_frame_t *out)
{
    if (out == NULL || words == NULL || word_count == 0U ||
        word_count > 123U) {
        return ESP_ERR_INVALID_ARG;
    }

    size_t byte_count = word_count * 2U;
    size_t payload_len = 7U + byte_count;
    if (payload_len + 2U > sizeof(out->data)) {
        return ESP_ERR_INVALID_SIZE;
    }

    memset(out, 0, sizeof(*out));
    out->data[0] = slave_id;
    out->data[1] = MOTOR_DIAG_FUNC_WRITE_MULTI;
    out->data[2] = (uint8_t)(address >> 8U);
    out->data[3] = (uint8_t)(address & 0xFFU);
    out->data[4] = (uint8_t)(word_count >> 8U);
    out->data[5] = (uint8_t)(word_count & 0xFFU);
    out->data[6] = (uint8_t)byte_count;
    for (size_t i = 0; i < word_count; i++) {
        out->data[7U + i * 2U] = (uint8_t)(words[i] >> 8U);
        out->data[8U + i * 2U] = (uint8_t)(words[i] & 0xFFU);
    }
    return finish_frame(out, payload_len);
}

esp_err_t motor_diag_build_osc_query(uint8_t slave_id, uint16_t item,
                                     motor_diag_frame_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out, 0, sizeof(*out));
    out->data[0] = slave_id;
    out->data[1] = MOTOR_DIAG_FUNC_READ_INPUT;
    out->data[2] = (uint8_t)(item >> 8U);
    out->data[3] = (uint8_t)(item & 0xFFU);
    out->data[4] = 0;
    out->data[5] = 1;
    return finish_frame(out, 6U);
}

esp_err_t motor_diag_build_osc_set_channel(uint8_t slave_id, uint8_t channel,
                                           uint8_t param_type,
                                           uint16_t address,
                                           motor_diag_frame_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out, 0, sizeof(*out));
    out->data[0] = slave_id;
    out->data[1] = MOTOR_DIAG_FUNC_OSC_CHANNEL;
    out->data[2] = channel;
    out->data[3] = param_type;
    out->data[4] = (uint8_t)(address >> 8U);
    out->data[5] = (uint8_t)(address & 0xFFU);
    return finish_frame(out, 6U);
}

static esp_err_t motor_diag_build_osc_short(uint8_t slave_id, uint8_t function,
                                           motor_diag_frame_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out, 0, sizeof(*out));
    out->data[0] = slave_id;
    out->data[1] = function;
    return finish_frame(out, 6U);
}

esp_err_t motor_diag_build_osc_start(uint8_t slave_id, motor_diag_frame_t *out)
{
    return motor_diag_build_osc_short(slave_id, MOTOR_DIAG_FUNC_OSC_START, out);
}

esp_err_t motor_diag_build_osc_stop(uint8_t slave_id, motor_diag_frame_t *out)
{
    return motor_diag_build_osc_short(slave_id, MOTOR_DIAG_FUNC_OSC_STOP, out);
}

esp_err_t motor_diag_build_osc_heartbeat(uint8_t slave_id,
                                         motor_diag_frame_t *out)
{
    return motor_diag_build_osc_short(slave_id, MOTOR_DIAG_FUNC_HEARTBEAT, out);
}

esp_err_t motor_diag_build_osc_rate(uint8_t slave_id, uint32_t bytes_per_sec,
                                    motor_diag_frame_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out, 0, sizeof(*out));
    out->data[0] = slave_id;
    out->data[1] = MOTOR_DIAG_FUNC_OSC_RATE;
    out->data[2] = (uint8_t)((bytes_per_sec >> 24U) & 0xFFU);
    out->data[3] = (uint8_t)((bytes_per_sec >> 16U) & 0xFFU);
    out->data[4] = (uint8_t)((bytes_per_sec >> 8U) & 0xFFU);
    out->data[5] = (uint8_t)(bytes_per_sec & 0xFFU);
    return finish_frame(out, 6U);
}

esp_err_t motor_diag_hex_encode(const uint8_t *data, size_t len,
                                char *out, size_t out_size)
{
    static const char hex[] = "0123456789ABCDEF";

    if (out == NULL || out_size == 0U || (len > 0U && data == NULL) ||
        out_size < len * 2U + 1U) {
        return ESP_ERR_INVALID_ARG;
    }

    for (size_t i = 0; i < len; i++) {
        out[i * 2U] = hex[data[i] >> 4U];
        out[i * 2U + 1U] = hex[data[i] & 0x0FU];
    }
    out[len * 2U] = '\0';
    return ESP_OK;
}

esp_err_t motor_diag_param_register(const motor_diag_param_t *param)
{
    if (param == NULL || param->alias[0] == '\0' || param->decimals > 9U) {
        return ESP_ERR_INVALID_ARG;
    }

    motor_diag_param_t normalized = *param;
    normalized.alias[sizeof(normalized.alias) - 1U] = '\0';
    normalized.unit[sizeof(normalized.unit) - 1U] = '\0';

    portENTER_CRITICAL(&s_param_lock);
    for (size_t i = 0; i < s_param_count; i++) {
        if (alias_equal(s_params[i].alias, normalized.alias)) {
            s_params[i] = normalized;
            portEXIT_CRITICAL(&s_param_lock);
            return ESP_OK;
        }
    }
    if (s_param_count >= MOTOR_DIAG_MAX_PARAMS) {
        portEXIT_CRITICAL(&s_param_lock);
        return ESP_ERR_NO_MEM;
    }
    s_params[s_param_count++] = normalized;
    portEXIT_CRITICAL(&s_param_lock);
    return ESP_OK;
}

bool motor_diag_param_find(const char *alias, motor_diag_param_t *out)
{
    bool found = false;

    if (alias == NULL || alias[0] == '\0') {
        return false;
    }

    portENTER_CRITICAL(&s_param_lock);
    for (size_t i = 0; i < s_param_count; i++) {
        if (alias_equal(s_params[i].alias, alias)) {
            if (out != NULL) {
                *out = s_params[i];
            }
            found = true;
            break;
        }
    }
    portEXIT_CRITICAL(&s_param_lock);
    return found;
}

bool motor_diag_param_find_in_text(const char *text, motor_diag_param_t *out)
{
    bool found = false;

    if (text == NULL || text[0] == '\0') {
        return false;
    }

    portENTER_CRITICAL(&s_param_lock);
    for (size_t i = 0; i < s_param_count; i++) {
        if (text_contains_alias(text, s_params[i].alias)) {
            if (out != NULL) {
                *out = s_params[i];
            }
            found = true;
            break;
        }
    }
    portEXIT_CRITICAL(&s_param_lock);
    return found;
}

size_t motor_diag_param_snapshot(motor_diag_param_t *out, size_t capacity)
{
    size_t count = 0;

    if (out == NULL || capacity == 0U) {
        return 0;
    }

    portENTER_CRITICAL(&s_param_lock);
    count = s_param_count < capacity ? s_param_count : capacity;
    memcpy(out, s_params, count * sizeof(out[0]));
    portEXIT_CRITICAL(&s_param_lock);
    return count;
}

size_t motor_diag_param_count(void)
{
    size_t count;
    portENTER_CRITICAL(&s_param_lock);
    count = s_param_count;
    portEXIT_CRITICAL(&s_param_lock);
    return count;
}

size_t motor_diag_param_capacity(void)
{
    return MOTOR_DIAG_MAX_PARAMS;
}

void motor_diag_param_clear(void)
{
    portENTER_CRITICAL(&s_param_lock);
    s_param_count = 0;
    memset(s_params, 0, sizeof(s_params));
    portEXIT_CRITICAL(&s_param_lock);
}

esp_err_t motor_diag_build_param_read(const motor_diag_param_t *param,
                                      uint8_t slave_id,
                                      motor_diag_frame_t *out)
{
    if (param == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    return motor_diag_build_read(slave_id, param->address,
                                 param->is_float ? 2U : 1U, out);
}

esp_err_t motor_diag_build_param_write(const motor_diag_param_t *param,
                                       uint8_t slave_id, double value,
                                       int32_t *raw_value,
                                       motor_diag_frame_t *out)
{
    if (param == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (param->is_float) {
        if (raw_value != NULL) {
            *raw_value = 0;
        }
        return motor_diag_build_write_float32(slave_id, param->address,
                                             (float)value, out);
    }
    return motor_diag_build_write_scaled(slave_id, param->address, value,
                                         param->decimals,
                                         param->signed_value,
                                         raw_value, out);
}
