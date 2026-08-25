#ifndef CLOUD_WS_LEASE_H
#define CLOUD_WS_LEASE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint32_t generation;
    bool active;
} cloud_ws_lease_gate_t;

static inline bool cloud_ws_lease_gate_apply(cloud_ws_lease_gate_t *gate,
                                             uint32_t generation,
                                             bool active)
{
    if (gate == NULL || generation == 0) {
        return false;
    }
    if (gate->generation != 0 &&
        (int32_t)(generation - gate->generation) < 0) {
        return false;
    }
    gate->generation = generation;
    gate->active = active;
    return true;
}

#endif /* CLOUD_WS_LEASE_H */
