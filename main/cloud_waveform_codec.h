#ifndef CLOUD_WAVEFORM_CODEC_H
#define CLOUD_WAVEFORM_CODEC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>


#define CLOUD_WAVEFORM_MAGIC "WDZ1"
#define CLOUD_WAVEFORM_HEADER_SIZE 16U
#define CLOUD_WAVEFORM_MAX_RAW_SIZE 32768U
#define CLOUD_WAVEFORM_MAX_WIRE_SIZE \
    (CLOUD_WAVEFORM_HEADER_SIZE + CLOUD_WAVEFORM_MAX_RAW_SIZE)

typedef enum {
    CLOUD_WAVEFORM_CODEC_RAW = 0,
    CLOUD_WAVEFORM_CODEC_ZLIB = 1,
} cloud_waveform_codec_t;

typedef struct {
    cloud_waveform_codec_t codec;
    bool compression_failed;
    size_t raw_len;
    size_t wire_len;
} cloud_waveform_encode_result_t;

typedef struct {
    void *workspace;
    size_t workspace_size;
} cloud_waveform_encoder_t;

size_t cloud_waveform_encoder_workspace_size(void);
bool cloud_waveform_encoder_init(cloud_waveform_encoder_t *encoder,
                                 void *workspace,
                                 size_t workspace_size);
bool cloud_waveform_encode(cloud_waveform_encoder_t *encoder,
                           const uint8_t *raw, size_t raw_len,
                           uint8_t *wire, size_t wire_capacity,
                           size_t *wire_len,
                           cloud_waveform_encode_result_t *result);

#endif /* CLOUD_WAVEFORM_CODEC_H */
