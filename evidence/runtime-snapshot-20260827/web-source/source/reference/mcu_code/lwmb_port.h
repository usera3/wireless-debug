#ifndef _LWMB_PORT_H_
#define _LWMB_PORT_H_

#include "lwmb.h"

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

#if LWMB_FRAME_MODE

void lwmb_start_recv_frame(uint8_t *buf, uint16_t len, void (*cplt)(uint8_t *data, uint16_t len), void (*error)());

void lwmb_reset_recv_frame();

#else 
uint16_t lwmb_get_stream_avaliable_data(void);
uint16_t lwmb_read_stream(uint8_t *buf, uint16_t len);
#endif

void lwmb_send_data(uint8_t *data, uint16_t len);

bool lwmb_check_valid_osc_addr(uint16_t addr_low, lwmb_osc_para_type_t type);

#ifdef __cplusplus
}
#endif // __cplusplus

#endif