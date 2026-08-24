#ifndef HOST_MINIZ_H
#define HOST_MINIZ_H

#include <zlib.h>

typedef uLong mz_ulong;

#define MZ_OK Z_OK
#define MZ_BUF_ERROR Z_BUF_ERROR
#define MZ_BEST_SPEED Z_BEST_SPEED
#define MZ_CRC32_INIT 0U
#define mz_compress2 compress2
#define mz_crc32 crc32

enum {
    TDEFL_WRITE_ZLIB_HEADER = 0x01000,
    TDEFL_GREEDY_PARSING_FLAG = 0x04000,
};

typedef enum {
    TDEFL_STATUS_BAD_PARAM = -2,
    TDEFL_STATUS_PUT_BUF_FAILED = -1,
    TDEFL_STATUS_OKAY = 0,
    TDEFL_STATUS_DONE = 1,
} tdefl_status;

typedef enum {
    TDEFL_NO_FLUSH = 0,
    TDEFL_SYNC_FLUSH = 2,
    TDEFL_FULL_FLUSH = 3,
    TDEFL_FINISH = 4,
} tdefl_flush;

typedef struct {
    int initialized;
} tdefl_compressor;

static inline tdefl_status tdefl_init(tdefl_compressor *compressor,
                                      void *put_buffer,
                                      void *put_buffer_user,
                                      int flags)
{
    (void)put_buffer;
    (void)put_buffer_user;
    (void)flags;
    if (compressor == NULL) {
        return TDEFL_STATUS_BAD_PARAM;
    }
    compressor->initialized = 1;
    return TDEFL_STATUS_OKAY;
}

static inline tdefl_status tdefl_compress(tdefl_compressor *compressor,
                                          const void *input,
                                          size_t *input_size,
                                          void *output,
                                          size_t *output_size,
                                          tdefl_flush flush)
{
    if (compressor == NULL || !compressor->initialized || input == NULL ||
        input_size == NULL || output == NULL || output_size == NULL ||
        flush != TDEFL_FINISH) {
        return TDEFL_STATUS_BAD_PARAM;
    }
    uLongf encoded_size = (uLongf)*output_size;
    int result = compress2(output, &encoded_size, input, (uLong)*input_size, Z_BEST_SPEED);
    *output_size = (size_t)encoded_size;
    if (result == Z_OK) {
        return TDEFL_STATUS_DONE;
    }
    return result == Z_BUF_ERROR ? TDEFL_STATUS_OKAY : TDEFL_STATUS_BAD_PARAM;
}

#endif
