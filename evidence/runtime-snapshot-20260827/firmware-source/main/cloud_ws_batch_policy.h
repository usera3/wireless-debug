#ifndef CLOUD_WS_BATCH_POLICY_H
#define CLOUD_WS_BATCH_POLICY_H

#include <stddef.h>
#include <stdint.h>


#define CLOUD_WS_BATCH_TARGET_BYTES 4096U
#define CLOUD_WS_BATCH_MAX_WAIT_US 40000U

uint32_t cloud_ws_batch_wait_us(size_t raw_len, uint32_t elapsed_us);

#endif /* CLOUD_WS_BATCH_POLICY_H */
