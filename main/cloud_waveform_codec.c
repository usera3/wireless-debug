#include "cloud_waveform_codec.h"

#include <string.h>

#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "miniz.h"

#define TDEFL_FASTEST_PROBES 1

static tdefl_compressor *s_compressor;

static void write_be32(uint8_t *out, uint32_t value)
{
    out[0] = (uint8_t)(value >> 24);
    out[1] = (uint8_t)(value >> 16);
    out[2] = (uint8_t)(value >> 8);
    out[3] = (uint8_t)value;
}

esp_err_t cloud_waveform_codec_init(void)
{
    if (s_compressor != NULL) {
        return ESP_OK;
    }

    s_compressor = heap_caps_calloc(
        1, sizeof(*s_compressor), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_compressor == NULL) {
        s_compressor = heap_caps_calloc(
            1, sizeof(*s_compressor), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    return s_compressor == NULL ? ESP_ERR_NO_MEM : ESP_OK;
}

void cloud_waveform_codec_deinit(void)
{
    heap_caps_free(s_compressor);
    s_compressor = NULL;
}

esp_err_t cloud_waveform_encode(const uint8_t *raw,
                                size_t raw_len,
                                uint8_t *wire,
                                size_t wire_cap,
                                size_t *wire_len,
                                cloud_waveform_codec_result_t *result)
{
    if (raw == NULL || raw_len == 0 || raw_len > CLOUD_WAVEFORM_MAX_RAW_BYTES ||
        wire == NULL || wire_len == NULL || result == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_compressor == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    if (wire_cap < CLOUD_WAVEFORM_HEADER_BYTES + raw_len) {
        return ESP_ERR_INVALID_SIZE;
    }

    int64_t started_us = esp_timer_get_time();
    uint32_t crc32 = (uint32_t)mz_crc32(MZ_CRC32_INIT, raw, raw_len);
    size_t input_len = raw_len;
    size_t compressed_len = wire_cap - CLOUD_WAVEFORM_HEADER_BYTES;
    tdefl_status compression_status = tdefl_init(
        s_compressor, NULL, NULL, TDEFL_WRITE_ZLIB_HEADER | TDEFL_FASTEST_PROBES);
    if (compression_status == TDEFL_STATUS_OKAY) {
        compression_status = tdefl_compress(
            s_compressor,
            raw,
            &input_len,
            wire + CLOUD_WAVEFORM_HEADER_BYTES,
            &compressed_len,
            TDEFL_FINISH);
    }

    cloud_waveform_codec_t codec = CLOUD_WAVEFORM_CODEC_DEFLATE;
    bool compression_failed = compression_status != TDEFL_STATUS_DONE ||
                              input_len != raw_len;
    if (compression_failed || compressed_len >= raw_len) {
        codec = CLOUD_WAVEFORM_CODEC_RAW;
        memcpy(wire + CLOUD_WAVEFORM_HEADER_BYTES, raw, raw_len);
        compressed_len = raw_len;
    }

    wire[0] = 'W';
    wire[1] = 'D';
    wire[2] = 'Z';
    wire[3] = '1';
    wire[4] = (uint8_t)codec;
    wire[5] = 0;
    wire[6] = 0;
    wire[7] = 0;
    write_be32(wire + 8, (uint32_t)raw_len);
    write_be32(wire + 12, crc32);

    *wire_len = CLOUD_WAVEFORM_HEADER_BYTES + (size_t)compressed_len;
    int64_t elapsed_us = esp_timer_get_time() - started_us;
    result->codec = codec;
    result->compression_failed = compression_failed;
    result->raw_len = raw_len;
    result->wire_len = *wire_len;
    result->compression_us = (uint32_t)(elapsed_us > 0 ? elapsed_us : 0);
    return ESP_OK;
}
