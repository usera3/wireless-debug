#ifndef __LWMB_H__
#define __LWMB_H__

#include <stdint.h>
#include <stdbool.h>
#include "SysMonitorConfig.h"

#define LWMB_VER_MAJOR 1
#define LWMB_VER_MINOR 0

// 模式配置
#if !defined(SYS_MONITOR_RECV_MODE) || SYS_MONITOR_RECV_MODE == SYS_MONITOR_MODE_FRAME
#define LWMB_FRAME_MODE 1 // 1:帧模式 0:流模式
#else
#define LWMB_FRAME_MODE 0 // 1:帧模式 0:流模式
#endif

#define LWMB_FRAME_TIMEOUT_US 10000 // 帧超时时间，单位:微秒

#if !defined(SYS_MONITOR_BAUDRATE) || SYS_MONITOR_BAUDRATE == 0
#define LWMB_COMM_BAUDRATE 2000000L // 默认通信波特率
#else
#define LWMB_COMM_BAUDRATE (uint32_t)(SYS_MONITOR_BAUDRATE) // 通信波特率
#endif

#define LWMB_COMM_TRANS_SPEED (uint32_t)(LWMB_COMM_BAUDRATE / 10 * 0.5) // 通信最大传输速度，单位: 字节/秒

#define LWMB_OSC_BUFFER_HEADER_SIZE (4)   // 示波缓冲区头部大小4字节
#define LWMB_OSC_BUFFER_CRC_SIZE    (2)   // 示波缓冲区CRC大小2字节
#define LWMB_OSC_BUFFER_TAIL_SIZE   (4)   // 示波缓冲区尾部大小2字节
#if !defined(SYS_MONITOR_OSC_BUFFER_SIZE) || SYS_MONITOR_OSC_BUFFER_SIZE == 0
#define LWMB_OSC_BUFFER_DATA_SIZE   (120) // 示波缓冲区数据区大小240字节
#else
#define LWMB_OSC_BUFFER_DATA_SIZE   (SYS_MONITOR_OSC_BUFFER_SIZE) // 示波缓冲区数据区大小
#endif
#define LWMB_OSC_BUFFER_MB_LEN_SIZE (1)   // 示波缓冲区Modbus数据长度大小1字节

#define LWMB_OSC_BUFFER_SIZE_NO_LEN                                                       \
    (LWMB_OSC_BUFFER_HEADER_SIZE + LWMB_OSC_BUFFER_DATA_SIZE + LWMB_OSC_BUFFER_CRC_SIZE + \
     LWMB_OSC_BUFFER_TAIL_SIZE) // 示波缓冲区大小（不含Modbus数据长度）
#define LWMB_OSC_BUFFER_SIZE                                                                                          \
    (LWMB_OSC_BUFFER_HEADER_SIZE + LWMB_OSC_BUFFER_DATA_SIZE + LWMB_OSC_BUFFER_CRC_SIZE + LWMB_OSC_BUFFER_TAIL_SIZE + \
     LWMB_OSC_BUFFER_MB_LEN_SIZE) // 示波缓冲区总大小

#define LWMB_OSC_BUFFER_DATA_START (LWMB_OSC_BUFFER_HEADER_SIZE)
#define LWMB_OSC_BUFFER_DATA_END   (LWMB_OSC_BUFFER_DATA_START + LWMB_OSC_BUFFER_DATA_SIZE) // 数据区结束位置

#define LWMB_OSC_HEARTBEAT_TIMEOUT 3 // 示波心跳超时时间，单位:秒

#define LWMB_TX_MAX_LENGTH 32 // 最大发送长度
#define LWMB_RX_MAX_LENGTH 20 // 最大接收长度
// 内部状态定义
typedef enum
{
    STATE_IDLE,
    STATE_RX,
    STATE_RX_END,
} lwmb_state_t;

typedef struct
{
    lwmb_state_t state;
    uint32_t     last_rx_time;
    uint8_t      rx_buf_a[LWMB_RX_MAX_LENGTH]; // 接收双缓冲A
#if LWMB_FRAME_MODE
    uint8_t rx_buf_b[LWMB_RX_MAX_LENGTH]; // 接收双缓冲B
#endif
    uint8_t          *active_rx_buf; // 当前活跃接收缓冲区
    uint16_t          rx_idx;
    uint8_t           tx_buf_a[LWMB_OSC_BUFFER_SIZE + LWMB_TX_MAX_LENGTH + 1]; // 发送双缓冲A
    uint8_t           tx_buf_b[LWMB_OSC_BUFFER_SIZE + LWMB_TX_MAX_LENGTH + 1]; // 发送双缓冲B
    uint8_t          *active_tx_buf;                                           // 当前活跃发送缓冲区
    uint8_t          *active_tx_mb_buf;                                        // 当前活跃发送Modbus缓冲区
    uint16_t          tx_idx;
    volatile uint8_t  mb_send_ready;
    int8_t            mb_reply_offset;
    uint8_t           osc_mode;       // 示波模式标志
    int8_t            osc_data_ready; // 示波数据就绪标志
    int16_t           osc_data_index; // 示波数据索引
    uint8_t           osc_occupied_channel; // 实际占用的通道数（每通道2字节）
    uint8_t           osc_real_channel;  // 真实通道数（示波器界面上的通道数）
    uint8_t           osc_sample_tick;
    uint8_t           osc_sample_tick_max;
    uint16_t          osc_crc_state;
    volatile uint32_t osc_heartbeat_tick; // 示波心跳计时
} lwmb_context;

// 回调函数类型定义
typedef void (*lwmb_rx_callback_t)(uint8_t *data, uint16_t len);

// 时间基准处理(在中断中调用)
void lwmb_tick(uint32_t elapsed_us);

// 轮询处理(在主循环中调用)
void lwmb_poll(void);

// 初始化Modbus协议栈
void lwmb_init(void);

// 启动modbus
void lwmb_start();

// osc采样
void lwmb_osc_sample();

extern lwmb_context ctx;

// Data相关功能（Modbus命令）

// 错误码定义
typedef enum
{
    LWMB_OK = 0,
    LWMB_OK_NO_REPLY,
    LWMB_ERR_TIMEOUT,
    LWMB_ERR_CRC,
    LWMB_ERR_FRAME,
    LWMB_ERR_FUNC
} lwmb_err_t;

// 标准功能码
#define LWMB_FUNC_READ_HOLD_REGS      0x03
#define LWMB_FUNC_READ_INPUT_REGS     0x04
#define LWMB_FUNC_WRITE_SINGLE_REGS   0x06
#define LWMB_FUNC_WRITE_MULTIPLE_REGS 0x10

#define LWMB_FUNC_OSC_HANDSHAKE  0x70
#define LWMB_FUNC_OSC_START      0x71
#define LWMB_FUNC_OSC_STOP       0x72
#define LWMB_FUNC_OSC_SET_RATE   0x73
#define LWMB_FUNC_OSC_SETCHN     0x75
#define LWMB_FUNC_OSC_HEART      0x08

// 用于OSC的特殊INPUT寄存器地址
#define LWMB_OSC_FRAME_LEN_ADDR         0x0000 // 示波帧长度寄存器地址
#define LWMB_OSC_FRAME_CHN_ADDR         0x0001 // 示波通道寄存器地址
#define LWMB_OSC_RATE_ADDR              0x0002 // 示波采样率寄存器地址
#define LWMB_OSC_RATE_ADDR_COMPTAITABLE 0x0201 // 示波采样率寄存器地址

// Modbus功能函数原型

lwmb_err_t lwmb_read_input_regs(uint8_t addr, uint16_t reg_addr, uint16_t reg_count, uint8_t *data, uint8_t *reply_data, uint16_t *reply_len);

lwmb_err_t lwmb_read_holding_regs(uint8_t addr, uint16_t reg_addr, uint16_t reg_count, uint8_t *data, uint8_t *reply_data, uint16_t *reply_len);

lwmb_err_t lwmb_write_single_reg(uint8_t addr, uint16_t reg_addr, uint16_t value, uint8_t *reply_data, uint16_t *reply_len);

lwmb_err_t lwmb_write_multiple_regs(uint8_t addr, uint16_t reg_addr, uint16_t reg_count, const uint8_t *data, uint8_t *reply_data,
                                    uint16_t *reply_len);

lwmb_err_t lwmb_osc_handshake(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len);

lwmb_err_t lwmb_osc_start(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len);

lwmb_err_t lwmb_osc_stop(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len);

lwmb_err_t lwmb_osc_setchn(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len);

lwmb_err_t lwmb_osc_set_rate(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len);

lwmb_err_t lwmb_osc_heart(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len);

// OSC相关功能

#if !defined(SYS_MONITOR_OSC_MAX_CHANNELS)
#define LWMB_OSC_MAX_CHANNEL 6 // 最大通道数
#else
#define LWMB_OSC_MAX_CHANNEL SYS_MONITOR_OSC_MAX_CHANNELS // 最大通道数
#endif

#if !defined(SYS_MONITOR_OSC_SAMPLE_RATE)
#define LWMB_OSC_SAMPLE_RATE 6000 // 默认采样率，单位:Hz
#else
#define LWMB_OSC_SAMPLE_RATE SYS_MONITOR_OSC_SAMPLE_RATE // 默认采样率，单位:Hz
#endif

typedef enum
{
    LWMB_OSC_PARA_TYPE_DEFAULT          = 0, // 默认16位整型
    LWMB_OSC_PARA_TYPE_ABS_INT8         = 1, // 8位整型
    LWMB_OSC_PARA_TYPE_ABS_INT16        = 2, // 16位整型
    LWMB_OSC_PARA_TYPE_ABS_INT32_FLOAT  = 3, // 32位整型/浮点型
    LWMB_OSC_PARA_TYPE_ABS_INT64_DOUBLE = 4, // 64位整型/浮点型
#ifdef SYS_MONITOR_OSC_FLOAT_SUPPORT
    LWMB_OSC_PARA_TYPE_ABS_FLOAT_TO_Q14 = 5, // 32位浮点型转换为16位整形(Q14)
    LWMB_OSC_PARA_TYPE_ABS_FLOAT_X_1000 = 6, // 32位浮点型转换为16位整形(x1000)
    LWMB_OSC_PARA_TYPE_ABS_DOUBLE_TO_FLOAT = 7, // 64位浮点型转换为32位
    LWMB_OSC_PARA_TYPE_ABS_DOUBLE_TO_Q14 = 8, // 64位浮点型转换为16位整形(Q14)
    LWMB_OSC_PARA_TYPE_ABS_DOUBLE_TO_1000 = 9, // 64位浮点型转换为16位整形(Q14)
#endif
} lwmb_osc_para_type_t;

typedef struct
{
    uint16_t page;     // 页号
    uint16_t index;    // 索引
    uint16_t paraType; // 参数类型
} lwmb_osc_channel_t;

extern lwmb_osc_channel_t osc_channels[LWMB_OSC_MAX_CHANNEL]; // 示波通道数组

#if !defined(SYS_ENABLE_MONITOR_PARA_MGR)
extern void (*lwmb_custom_rw_callback)(uint16_t id, uint16_t *value, int8_t is_write); // 自定义读写回调函数
#endif

#endif // __LWMB_H__
