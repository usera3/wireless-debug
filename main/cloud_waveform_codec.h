#ifndef CLOUD_WAVEFORM_CODEC_H
#define CLOUD_WAVEFORM_CODEC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CLOUD_WAVEFORM_MAGIC "WDZ1"
#define CLOUD_WAVEFORM_HEADER_BYTES 16U
#define CLOUD_WAVEFORM_MAX_RAW_BYTES 32768U
#define CLOUD_WAVEFORM_MAX_WIRE_BYTES \
    (CLOUD_WAVEFORM_HEADER_BYTES + CLOUD_WAVEFORM_MAX_RAW_BYTES + 256U)

typedef enum {
    CLOUD_WAVEFORM_CODEC_RAW = 0,
    CLOUD_WAVEFORM_CODEC_DEFLATE = 1,
} cloud_waveform_codec_t;

typedef struct {
    cloud_waveform_codec_t codec;
    bool compression_failed;
    size_t raw_len;
    size_t wire_len;
    uint32_t compression_us;
} cloud_waveform_codec_result_t;

esp_err_t cloud_waveform_codec_init(void);
void cloud_waveform_codec_deinit(void);
esp_err_t cloud_waveform_encode(const uint8_t *raw,
                                size_t raw_len,
                                uint8_t *wire,
                                size_t wire_cap,
                                size_t *wire_len,
                                cloud_waveform_codec_result_t *result);

#ifdef __cplusplus
}
#endif

#endif
