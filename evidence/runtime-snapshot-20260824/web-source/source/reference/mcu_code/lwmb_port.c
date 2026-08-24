#include "lwmb_port.h"
#include "sys_monitor_port.h"
#include <stdbool.h>

#if LWMB_FRAME_MODE

void lwmb_start_recv_frame(uint8_t *buf, uint16_t len, void (*cplt)(uint8_t *data, uint16_t len), void (*error)())
{
    SysMonitorStartRecvFrame(buf, len, cplt, error);
}

void lwmb_reset_recv_frame()
{
    SysMonitorResetRecvFrame();
}

#else 
uint16_t lwmb_get_stream_avaliable_data(void)
{
    return SysMonitorGetStreamAvailableData();
}
uint16_t lwmb_read_stream(uint8_t *buf, uint16_t len)
{
    return SysMonitorReadStream(buf, len);
}
#endif

void lwmb_send_data(uint8_t *data, uint16_t len)
{
    if (len > LWMB_TX_MAX_LENGTH + LWMB_OSC_BUFFER_SIZE) {
        len = LWMB_TX_MAX_LENGTH + LWMB_OSC_BUFFER_SIZE; // 限制发送长度
    }
    
    SysMonitorSendData(data, len);
}

bool lwmb_check_valid_osc_addr(uint16_t addr_low, lwmb_osc_para_type_t type)
{
    return true;
}
