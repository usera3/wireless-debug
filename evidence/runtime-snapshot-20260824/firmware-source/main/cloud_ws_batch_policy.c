#include "cloud_ws_batch_policy.h"


uint32_t cloud_ws_batch_wait_us(size_t raw_len, uint32_t elapsed_us)
{
    if (raw_len >= CLOUD_WS_BATCH_TARGET_BYTES ||
        elapsed_us >= CLOUD_WS_BATCH_MAX_WAIT_US) {
        return 0;
    }
    return CLOUD_WS_BATCH_MAX_WAIT_US - elapsed_us;
}
