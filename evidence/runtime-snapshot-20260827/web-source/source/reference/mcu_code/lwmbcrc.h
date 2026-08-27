#ifndef __LWMB_CRC_H__
#define __LWMB_CRC_H__

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief 计算Modbus CRC16校验值
 * @param data 数据指针
 * @param len 数据长度
 * @return CRC16校验值
 */
uint16_t lwmb_crc16(uint8_t *data, uint16_t len);

uint16_t lwmb_crc16_continue(uint8_t *data, uint16_t len, uint16_t current);

uint16_t lwmb_crc16_continue_fill_zero(uint16_t len, uint16_t current);

#ifdef __cplusplus
}
#endif

#endif /* __LWMB_CRC_H__ */
