#include <assert.h>
#include <stdbool.h>
#include <stdint.h>

#include "cloud_ws_lease.h"

int main(void)
{
    cloud_ws_lease_gate_t gate = {0};

    assert(cloud_ws_lease_gate_apply(&gate, 1, true));
    assert(gate.active);
    assert(gate.generation == 1);

    assert(!cloud_ws_lease_gate_apply(&gate, 0, false));
    assert(gate.active);

    assert(cloud_ws_lease_gate_apply(&gate, 2, false));
    assert(!gate.active);

    assert(!cloud_ws_lease_gate_apply(&gate, 1, true));
    assert(!gate.active);

    assert(cloud_ws_lease_gate_apply(&gate, 3, true));
    assert(gate.active);

    gate.generation = UINT32_MAX;
    gate.active = false;
    assert(cloud_ws_lease_gate_apply(&gate, 1, true));
    assert(gate.active);
    assert(!cloud_ws_lease_gate_apply(&gate, UINT32_MAX, false));
    assert(gate.active);
    return 0;
}
