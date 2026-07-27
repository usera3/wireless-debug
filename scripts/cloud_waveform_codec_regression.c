#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cloud_waveform_codec.h"
#include "miniz.h"


static uint32_t read_be32(const uint8_t *data)
{
    return ((uint32_t)data[0] << 24) |
           ((uint32_t)data[1] << 16) |
           ((uint32_t)data[2] << 8) |
           (uint32_t)data[3];
}

static void expect_round_trip(const uint8_t *raw, size_t raw_len,
                              cloud_waveform_codec_t expected_codec)
{
    uint8_t *wire = malloc(CLOUD_WAVEFORM_MAX_WIRE_SIZE);
    uint8_t *restored = malloc(raw_len);
    assert(wire != NULL);
    assert(restored != NULL);

    size_t wire_len = 0;
    cloud_waveform_encode_result_t result = {0};
    assert(cloud_waveform_encode(raw, raw_len, wire,
                                 CLOUD_WAVEFORM_MAX_WIRE_SIZE,
                                 &wire_len, &result));
    assert(wire_len == result.wire_len);
    assert(result.raw_len == raw_len);
    assert(result.codec == expected_codec);
    assert(!result.compression_failed);
    assert(memcmp(wire, CLOUD_WAVEFORM_MAGIC, 4) == 0);
    assert(wire[4] == (uint8_t)expected_codec);
    assert(wire[5] == 0 && wire[6] == 0 && wire[7] == 0);
    assert(read_be32(wire + 8) == raw_len);
    assert(read_be32(wire + 12) ==
           (uint32_t)mz_crc32(MZ_CRC32_INIT, raw, raw_len));

    if (expected_codec == CLOUD_WAVEFORM_CODEC_RAW) {
        assert(wire_len == CLOUD_WAVEFORM_HEADER_SIZE + raw_len);
        memcpy(restored, wire + CLOUD_WAVEFORM_HEADER_SIZE, raw_len);
    } else {
        uLongf restored_len = (uLongf)raw_len;
        assert(uncompress(restored, &restored_len,
                          wire + CLOUD_WAVEFORM_HEADER_SIZE,
                          wire_len - CLOUD_WAVEFORM_HEADER_SIZE) == Z_OK);
        assert(restored_len == raw_len);
    }
    assert(memcmp(restored, raw, raw_len) == 0);
    free(restored);
    free(wire);
}

static uint32_t next_random(uint32_t *state)
{
    uint32_t value = *state;
    value ^= value << 13;
    value ^= value >> 17;
    value ^= value << 5;
    *state = value;
    return value;
}

static void test_valid_envelopes(void)
{
    uint8_t *zeros = calloc(1, CLOUD_WAVEFORM_MAX_RAW_SIZE);
    uint8_t *random = malloc(8192);
    assert(zeros != NULL);
    assert(random != NULL);
    uint32_t state = 0x57445A31U;
    for (size_t index = 0; index < 8192; ++index) {
        random[index] = (uint8_t)next_random(&state);
    }

    expect_round_trip(zeros, CLOUD_WAVEFORM_MAX_RAW_SIZE,
                      CLOUD_WAVEFORM_CODEC_ZLIB);
    expect_round_trip(random, 8192, CLOUD_WAVEFORM_CODEC_RAW);
    free(random);
    free(zeros);
}

static void test_invalid_arguments(void)
{
    uint8_t raw[2] = {1, 2};
    uint8_t wire[CLOUD_WAVEFORM_HEADER_SIZE + sizeof(raw)] = {0};
    size_t wire_len = 0;
    cloud_waveform_encode_result_t result = {0};

    assert(!cloud_waveform_encode(NULL, sizeof(raw), wire, sizeof(wire),
                                  &wire_len, &result));
    assert(!cloud_waveform_encode(raw, 0, wire, sizeof(wire),
                                  &wire_len, &result));
    assert(!cloud_waveform_encode(raw, CLOUD_WAVEFORM_MAX_RAW_SIZE + 1U,
                                  wire, sizeof(wire), &wire_len, &result));
    assert(!cloud_waveform_encode(raw, sizeof(raw), NULL, sizeof(wire),
                                  &wire_len, &result));
    assert(!cloud_waveform_encode(raw, sizeof(raw), wire, sizeof(wire) - 1U,
                                  &wire_len, &result));
    assert(!cloud_waveform_encode(raw, sizeof(raw), wire, sizeof(wire),
                                  NULL, &result));
    assert(!cloud_waveform_encode(raw, sizeof(raw), wire, sizeof(wire),
                                  &wire_len, NULL));
}

static int emit_stdin_envelope(void)
{
    uint8_t *raw = malloc(CLOUD_WAVEFORM_MAX_RAW_SIZE + 1U);
    uint8_t *wire = malloc(CLOUD_WAVEFORM_MAX_WIRE_SIZE);
    if (raw == NULL || wire == NULL) {
        free(raw);
        free(wire);
        return 2;
    }
    size_t raw_len = fread(raw, 1, CLOUD_WAVEFORM_MAX_RAW_SIZE + 1U, stdin);
    size_t wire_len = 0;
    cloud_waveform_encode_result_t result = {0};
    bool ok = raw_len <= CLOUD_WAVEFORM_MAX_RAW_SIZE &&
              cloud_waveform_encode(raw, raw_len, wire,
                                    CLOUD_WAVEFORM_MAX_WIRE_SIZE,
                                    &wire_len, &result);
    if (!ok || fwrite(wire, 1, wire_len, stdout) != wire_len) {
        free(raw);
        free(wire);
        return 3;
    }
    free(raw);
    free(wire);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--encode") == 0) {
        return emit_stdin_envelope();
    }
    test_valid_envelopes();
    test_invalid_arguments();
    puts("cloud waveform C codec regression passed");
    return 0;
}
