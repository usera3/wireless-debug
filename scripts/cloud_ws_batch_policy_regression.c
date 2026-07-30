#include "cloud_ws_batch_policy.h"

#include <assert.h>
#include <stdio.h>

int main(void)
{
    assert(CLOUD_WS_BATCH_TARGET_BYTES == 4096U);
    assert(CLOUD_WS_BATCH_MAX_WAIT_US == 40000U);

    assert(cloud_ws_batch_wait_us(250U, 0U) == 40000U);
    assert(cloud_ws_batch_wait_us(2048U, 10000U) == 30000U);
    assert(cloud_ws_batch_wait_us(4095U, 39999U) == 1U);
    assert(cloud_ws_batch_wait_us(4096U, 0U) == 0U);
    assert(cloud_ws_batch_wait_us(8192U, 1000U) == 0U);
    assert(cloud_ws_batch_wait_us(250U, 40000U) == 0U);
    assert(cloud_ws_batch_wait_us(250U, 50000U) == 0U);

    puts("cloud websocket batch policy regression passed");
    return 0;
}
