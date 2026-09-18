#include "cloud_waveform_codec.h"

#include <string.h>

#include "miniz.h"

#define CLOUD_WAVEFORM_TDEFL_LEVEL1_FLAGS \
    (TDEFL_WRITE_ZLIB_HEADER | TDEFL_GREEDY_PARSING_FLAG | 1)


static void write_be32(uint8_t *data, uint32_t value)
{
    data[0] = (uint8_t)(value >> 24);
    data[1] = (uint8_t)(value >> 16);
    data[2] = (uint8_t)(value >> 8);
    data[3] = (uint8_t)value;
}

size_t cloud_waveform_encoder_workspace_size(void)
{
    return sizeof(tdefl_compressor);
}

bool cloud_waveform_encoder_init(cloud_waveform_encoder_t *encoder,
                                 void *workspace,
                                 size_t workspace_size)
{
    if (encoder == NULL || workspace == NULL ||
        workspace_size < sizeof(tdefl_compressor)) {
        return false;
    }
    *encoder = (cloud_waveform_encoder_t){
        .workspace = workspace,
        .workspace_size = workspace_size,
    };
    return true;
}

bool cloud_waveform_encode(cloud_waveform_encoder_t *encoder,
                           const uint8_t *raw, size_t raw_len,
                           uint8_t *wire, size_t wire_capacity,
                           size_t *wire_len,
                           cloud_waveform_encode_result_t *result)
{
    if (encoder == NULL || encoder->workspace == NULL ||
        encoder->workspace_size < sizeof(tdefl_compressor) ||
        raw == NULL || raw_len == 0 || raw_len > CLOUD_WAVEFORM_MAX_RAW_SIZE ||
        wire == NULL || wire_capacity < CLOUD_WAVEFORM_HEADER_SIZE + raw_len ||
        wire_len == NULL || result == NULL) {
        return false;
    }

    tdefl_compressor *compressor = (tdefl_compressor *)encoder->workspace;
    tdefl_status compression_result = tdefl_init(
        compressor, NULL, NULL, CLOUD_WAVEFORM_TDEFL_LEVEL1_FLAGS);
    size_t consumed_len = raw_len;
    size_t compressed_len = raw_len;
    if (compression_result == TDEFL_STATUS_OKAY) {
        compression_result = tdefl_compress(
            compressor,
            raw,
            &consumed_len,
            wire + CLOUD_WAVEFORM_HEADER_SIZE,
            &compressed_len,
            TDEFL_FINISH);
    }

    cloud_waveform_codec_t codec = CLOUD_WAVEFORM_CODEC_RAW;
    size_t encoded_len = raw_len;
    if (compression_result == TDEFL_STATUS_DONE &&
        consumed_len == raw_len && compressed_len < raw_len) {
        codec = CLOUD_WAVEFORM_CODEC_ZLIB;
        encoded_len = (size_t)compressed_len;
    } else {
        memcpy(wire + CLOUD_WAVEFORM_HEADER_SIZE, raw, raw_len);
    }

    memcpy(wire, CLOUD_WAVEFORM_MAGIC, 4);
    wire[4] = (uint8_t)codec;
    wire[5] = 0;
    wire[6] = 0;
    wire[7] = 0;
    write_be32(wire + 8, (uint32_t)raw_len);
    write_be32(
        wire + 12,
        (uint32_t)mz_crc32(MZ_CRC32_INIT, raw, raw_len));

    *wire_len = CLOUD_WAVEFORM_HEADER_SIZE + encoded_len;
    *result = (cloud_waveform_encode_result_t){
        .codec = codec,
        .compression_failed = compression_result < TDEFL_STATUS_OKAY,
        .raw_len = raw_len,
        .wire_len = *wire_len,
    };
    return true;
}
