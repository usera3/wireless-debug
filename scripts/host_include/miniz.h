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

#endif
