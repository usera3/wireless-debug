#include "lwmb.h"
#include "lwmbcrc.h"
#include "lwmb_port.h"
#include <stdint.h>
#include <string.h>

#if defined(SYS_ENABLE_MONITOR_PARA_MGR)
#include "sys_para_mgr.h"
#endif

lwmb_context ctx;

lwmb_osc_channel_t osc_channels[LWMB_OSC_MAX_CHANNEL];

uint8_t lwmb_osc_sample_buf[LWMB_OSC_MAX_CHANNEL * 2];

#if !defined(SYS_ENABLE_MONITOR_PARA_MGR)
void (*lwmb_custom_rw_callback)(uint16_t id, uint16_t *value, int8_t is_write) = NULL;
#endif

// 使用lwmbcrc模块的CRC计算
static uint16_t crc16(uint8_t *data, uint16_t len)
{
    return lwmb_crc16(data, len);
}

static void lwmb_rx_frame_error_callback(void);
static void lwmb_rx_frame_callback(uint8_t *data, uint16_t len);

static uint8_t *lwmb_get_idle_tx_buf(void)
{
    return (ctx.active_tx_buf == ctx.tx_buf_a) ? ctx.tx_buf_b : ctx.tx_buf_a;
}

static uint8_t *lwmb_get_idle_rx_buf(void)
{
    return (ctx.active_rx_buf == ctx.rx_buf_a) ? ctx.rx_buf_b : ctx.rx_buf_a;
}

static void lwmb_mark_mb_tx(uint8_t *data, uint16_t len)
{
    // 仅设置发送标记
    ctx.mb_send_ready = 1; // 设置发送标记

    // 在OSC模式下，记录发送数据长度到mb发送缓冲区结束后一个字节
    data[LWMB_TX_MAX_LENGTH] = len;
}

static void lwmb_start_osc_mode()
{
    if (ctx.osc_occupied_channel > 0)
    {
        ctx.osc_mode           = 1;                          // 设置示波模式标志
        ctx.osc_data_ready     = 0;                          // 清除示波数据就绪标记
        ctx.osc_data_index     = LWMB_OSC_BUFFER_DATA_START; // 重置示波数据索引
        ctx.osc_sample_tick    = 0;                          // 重置采样间隔计数
        ctx.osc_heartbeat_tick = 0;
    }
}

static void lwmb_stop_osc_mode()
{
    // 停止示波模式
    ctx.osc_mode             = 0; // 清除示波模式标志
    ctx.osc_occupied_channel = 0; // 重置占用通道数
    ctx.osc_real_channel     = 0; // 重置实际通道数
    ctx.osc_data_ready       = 0; // 清除示波数据就绪标记
    ctx.osc_sample_tick_max  = 1; // 重置采样间隔最大值
}

static void lwmb_handle_osc_heartbeat()
{
    // 处理示波心跳
    ctx.osc_heartbeat_tick = 0; // 重置示波心跳计时
}

static void lwmb_start_tx_mb()
{
    // 启动Modbus发送
    if (ctx.mb_send_ready)
    {
        // 仅在OSC模式下使用active缓冲区
        lwmb_send_data(ctx.active_tx_mb_buf + ctx.mb_reply_offset, ctx.tx_idx - ctx.mb_reply_offset);
        ctx.mb_send_ready = 0; // 清除发送标记
    }
}

static void lwmb_start_tx_osc()
{
    // osc_data_ready标记为1代表缓冲区已由示波采样交换，此时有效数据位于idle缓冲区
    if (ctx.osc_data_ready)
    {
        uint8_t *valid_buf   = lwmb_get_idle_tx_buf();
        uint8_t  mb_send_len = valid_buf[LWMB_OSC_BUFFER_SIZE + LWMB_TX_MAX_LENGTH]; // 获取Modbus数据长度

        // 如果当前缓冲区有Modbus数据需要发送
        if (mb_send_len > 0)
        {
            valid_buf[LWMB_OSC_BUFFER_SIZE - 1] = mb_send_len; // osc_buffer最后一个字节为Modbus数据长度
            lwmb_send_data(valid_buf, LWMB_OSC_BUFFER_SIZE + mb_send_len);
            valid_buf[LWMB_OSC_BUFFER_SIZE + LWMB_TX_MAX_LENGTH] = 0; // 清除发送缓冲区modbus数据长度
            ctx.tx_idx                                           = 0; // 重置发送索引
            ctx.mb_send_ready                                    = 0; // 清除发送标记
        }
        else
        {
            lwmb_send_data(valid_buf, LWMB_OSC_BUFFER_SIZE - 1); // 无modbus数据则不需要发送长度
        }

        ctx.osc_data_ready = 0; // 清除示波数据就绪标记
    }
}

static uint8_t lwmb_osc_calc_sample_tick(uint8_t chn, uint32_t comm_trans_speed)
{
    // 计算示波采样间隔；comm_trans_speed 为 0 时使用默认波特率换算值
    if (comm_trans_speed == 0)
    {
        comm_trans_speed = LWMB_COMM_TRANS_SPEED;
    }
    return ((chn * 2 * LWMB_OSC_SAMPLE_RATE) / comm_trans_speed) + 1; // 每个通道2字节数据
}

static void lwmb_osc_fill_data(uint8_t *data, uint16_t len)
{
    // 填充示波数据到当前活跃缓冲区
    if (ctx.osc_data_index + len > LWMB_OSC_BUFFER_DATA_END) // 6字节用于CRC和尾
    {
        // 如果当前缓冲区空间不足，则全部填0，计算CRC并准备发送
        memset(&ctx.active_tx_buf[ctx.osc_data_index], 0, LWMB_OSC_BUFFER_DATA_END - ctx.osc_data_index);

#if defined(SYS_MONITOR_OSC_CRC_CHECK) && SYS_MONITOR_OSC_CRC_CHECK != 0
        // 更新填充数据CRC
        ctx.osc_crc_state                           = lwmb_crc16_continue_fill_zero(LWMB_OSC_BUFFER_DATA_END - ctx.osc_data_index, ctx.osc_crc_state);
        ctx.active_tx_buf[LWMB_OSC_BUFFER_DATA_END] = ctx.osc_crc_state & 0xFF; // CRC低字节
        ctx.active_tx_buf[LWMB_OSC_BUFFER_DATA_END + 1] = (ctx.osc_crc_state >> 8) & 0xFF;
#endif
        // 交换活跃发送缓冲区
        ctx.active_tx_buf    = lwmb_get_idle_tx_buf();
        ctx.active_tx_mb_buf = ctx.active_tx_buf + LWMB_OSC_BUFFER_SIZE; // Modbus数据区

        ctx.osc_data_ready = 1;                          // 设置示波数据就绪标记
        ctx.osc_data_index = LWMB_OSC_BUFFER_DATA_START; // 重置示波数据索引，4字节用于帧头

        // 当前数据复制到新缓冲区
        memcpy(&ctx.active_tx_buf[ctx.osc_data_index], data, len);

#if defined(SYS_MONITOR_OSC_CRC_CHECK) && SYS_MONITOR_OSC_CRC_CHECK != 0
        // 更新当前CRC
        ctx.osc_crc_state = 0xffff;
        ctx.osc_crc_state = lwmb_crc16_continue(data, len, ctx.osc_crc_state);
#endif
    }
    else
    {
        // 如果当前缓冲区有足够空间，直接复制数据
        memcpy(&ctx.active_tx_buf[ctx.osc_data_index], data, len);
        ctx.osc_data_index += len; // 更新示波数据索引

        // 更新当前CRC
#if defined(SYS_MONITOR_OSC_CRC_CHECK) && SYS_MONITOR_OSC_CRC_CHECK != 0
        ctx.osc_crc_state = lwmb_crc16_continue(data, len, ctx.osc_crc_state);
#endif
        if (ctx.osc_data_index == LWMB_OSC_BUFFER_DATA_END)
        {

#if defined(SYS_MONITOR_OSC_CRC_CHECK) && SYS_MONITOR_OSC_CRC_CHECK != 0
            // 如果填充后正好满，则加入CRC数据，交换活跃发送缓冲区并准备发送
            ctx.active_tx_buf[LWMB_OSC_BUFFER_DATA_END]     = ctx.osc_crc_state & 0xFF; // CRC低字节
            ctx.active_tx_buf[LWMB_OSC_BUFFER_DATA_END + 1] = (ctx.osc_crc_state >> 8) & 0xFF;
            ctx.osc_crc_state                               = 0xffff;
#endif

            ctx.active_tx_buf    = lwmb_get_idle_tx_buf();
            ctx.active_tx_mb_buf = ctx.active_tx_buf + LWMB_OSC_BUFFER_SIZE; // Modbus数据区

            ctx.osc_data_ready = 1;                          // 设置示波数据就绪标记
            ctx.osc_data_index = LWMB_OSC_BUFFER_DATA_START; // 重置示波数据索引，4字节用于帧头
        }
    }
}

void lwmb_osc_sample()
{
    uint32_t abs_addr;
    uint8_t  u8_temp;
    uint16_t u16_temp;
    uint32_t u32_temp;
    uint64_t u64_temp;
    int32_t  s32_tmp;
    if (ctx.osc_mode)
    {
        ctx.osc_sample_tick += 1; // 增加采样间隔计数
        if (ctx.osc_sample_tick >= ctx.osc_sample_tick_max)
        {
            // 达到采样间隔，重置计数，并开始采样
            ctx.osc_sample_tick = 0; // 重置采样间隔计数
            int index           = 0; // i代表数据填充位置
            for (int channel = 0; channel < ctx.osc_real_channel; channel++)
            {
                switch (osc_channels[channel].paraType)
                {
                case LWMB_OSC_PARA_TYPE_ABS_INT8:
                    abs_addr = ((uint32_t)osc_channels[channel].page << 16) | osc_channels[channel].index;
                    // 8位数据按16位处理，高位填0
                    u8_temp                            = *((uint8_t *)abs_addr);
                    lwmb_osc_sample_buf[index * 2]     = 0;               // 高字节
                    lwmb_osc_sample_buf[index * 2 + 1] = u8_temp; // 低字节
                    index += 1;
                    break;
                case LWMB_OSC_PARA_TYPE_DEFAULT:
                case LWMB_OSC_PARA_TYPE_ABS_INT16:
                    abs_addr = ((uint32_t)osc_channels[channel].page << 16) | osc_channels[channel].index;
                    // 处理无符号16位整数
                    u16_temp                           = *((uint16_t *)abs_addr);
                    lwmb_osc_sample_buf[index * 2]     = (u16_temp >> 8) & 0xFF; // 高字节
                    lwmb_osc_sample_buf[index * 2 + 1] = u16_temp & 0xFF;        // 低字节
                    index += 1;
                    break;
#ifdef SYS_MONITOR_OSC_FLOAT_SUPPORT
                case LWMB_OSC_PARA_TYPE_ABS_FLOAT_TO_Q14:
                    abs_addr = ((uint32_t)osc_channels[channel].page << 16) | osc_channels[channel].index;
                    // 处理无符号16位整数
                    s32_tmp                            = *((float *)abs_addr) * 16384;
                    u16_temp                           = s32_tmp;
                    lwmb_osc_sample_buf[index * 2]     = (u16_temp >> 8) & 0xFF; // 高字节
                    lwmb_osc_sample_buf[index * 2 + 1] = u16_temp & 0xFF;        // 低字节
                    index += 1;
                    break;
                case LWMB_OSC_PARA_TYPE_ABS_FLOAT_X_1000:
                    abs_addr = ((uint32_t)osc_channels[channel].page << 16) | osc_channels[channel].index;
                    // 处理无符号16位整数
                    s32_tmp                            = *((float *)abs_addr) * 1000;
                    u16_temp                           = s32_tmp;
                    lwmb_osc_sample_buf[index * 2]     = (u16_temp >> 8) & 0xFF; // 高字节
                    lwmb_osc_sample_buf[index * 2 + 1] = u16_temp & 0xFF;        // 低字节
                    index += 1;
                    break;
#endif
                case LWMB_OSC_PARA_TYPE_ABS_INT32_FLOAT:
                    abs_addr = ((uint32_t)osc_channels[channel].page << 16) | osc_channels[channel].index;
                    // 处理无符号32位整数
                    u32_temp                           = *((uint32_t *)abs_addr);
                    lwmb_osc_sample_buf[index * 2]     = (u32_temp >> 24) & 0xFF; // 高字节
                    lwmb_osc_sample_buf[index * 2 + 1] = (u32_temp >> 16) & 0xFF; // 次高字节
                    lwmb_osc_sample_buf[index * 2 + 2] = (u32_temp >> 8) & 0xFF;  // 次低字节
                    lwmb_osc_sample_buf[index * 2 + 3] = u32_temp & 0xFF;         // 低字节
                    index += 2;
                    break;
                case LWMB_OSC_PARA_TYPE_ABS_INT64_DOUBLE:
                    abs_addr = ((uint32_t)osc_channels[channel].page << 16) | osc_channels[channel].index;
                    // 处理无符号64位整数
                    u64_temp                           = *((uint64_t *)abs_addr);
                    lwmb_osc_sample_buf[index * 2]     = (u64_temp >> 56) & 0xFF; // 高字节
                    lwmb_osc_sample_buf[index * 2 + 1] = (u64_temp >> 48) & 0xFF; // 次高字节
                    lwmb_osc_sample_buf[index * 2 + 2] = (u64_temp >> 40) & 0xFF; // 次次高字节
                    lwmb_osc_sample_buf[index * 2 + 3] = (u64_temp >> 32) & 0xFF; // 次次低字节
                    lwmb_osc_sample_buf[index * 2 + 4] = (u64_temp >> 24) & 0xFF; // 次低字节
                    lwmb_osc_sample_buf[index * 2 + 5] = (u64_temp >> 16) & 0xFF; // 低字节
                    lwmb_osc_sample_buf[index * 2 + 6] = (u64_temp >> 8) & 0xFF;  // 次低字节
                    lwmb_osc_sample_buf[index * 2 + 7] = u64_temp & 0xFF;         // 低字节
                    index += 4;
                    break;
                }
            }
            lwmb_osc_fill_data(lwmb_osc_sample_buf, ctx.osc_occupied_channel * 2); // 填充示波数据到当前活跃缓冲区
        }

        ctx.osc_heartbeat_tick += 1; // 增加示波心跳计时
        if (ctx.osc_heartbeat_tick >= (uint32_t)LWMB_OSC_SAMPLE_RATE * LWMB_OSC_HEARTBEAT_TIMEOUT)
        {
            lwmb_stop_osc_mode(); // 超时则停止示波模式
        }

        lwmb_start_tx_osc(); // 在示波模式下发送数据
    }
}

#if !LWMB_FRAME_MODE
// 流模式处理
static void process_stream(uint8_t *data, uint16_t len)
{
    // 缓存接收数据到当前活跃缓冲区
    if (ctx.rx_idx + len > LWMB_RX_MAX_LENGTH)
    {
        ctx.rx_idx = 0;
        ctx.state  = STATE_IDLE;
        return;
    }

    memcpy(&ctx.active_rx_buf[ctx.rx_idx], data, len);
    ctx.rx_idx += len;
    ctx.last_rx_time = 0;        // 重置超时计时
    ctx.state        = STATE_RX; // 设置状态为接收中
}
#endif

static void lwmb_build_error_response(uint8_t *buf, uint8_t func, lwmb_err_t err)
{
    buf[0]     = ctx.active_rx_buf[0]; // 保留地址
    buf[1]     = func | 0x80;          // 错误响应功能码
    buf[2]     = (uint8_t)err;         // 错误码
    ctx.tx_idx = 3;                    // 错误响应长度
}

// 检查并处理完整帧(由lwmb_poll调用)
static void check_complete_frame(void)
{
    // 储存当前缓冲区，避免新收到数据使得缓冲器在处理一半时交换
    uint8_t *proc_buffer = ctx.active_rx_buf;
    uint16_t proc_len    = ctx.rx_idx;
    uint8_t *mb_send_buf = ctx.active_tx_mb_buf;

    uint16_t crc       = crc16(proc_buffer, proc_len - 2);
    uint16_t frame_crc = (proc_buffer[proc_len - 1] << 8) | proc_buffer[proc_len - 2];
    // 由于示波模式引入，可能modbus协议需要发送额外数据，放在mb协议缓冲区之前
    // OSC_STOP帧需要左偏移1byte附加上帧长
    ctx.mb_reply_offset = 0;

    if (crc == frame_crc)
    {
        lwmb_handle_osc_heartbeat(); // 重置示波心跳计时，任意有效数据包均可当作心跳
        uint8_t    addr = proc_buffer[0];
        uint8_t    func = proc_buffer[1];
        uint16_t   reg_addr, reg_count;
        uint8_t   *data;
        lwmb_err_t res = LWMB_OK;
        switch (func)
        {
        case LWMB_FUNC_READ_INPUT_REGS:
            reg_addr  = (proc_buffer[2] << 8) | proc_buffer[3];
            reg_count = (proc_buffer[4] << 8) | proc_buffer[5];
            data      = &proc_buffer[6];
            res       = lwmb_read_input_regs(addr, reg_addr, reg_count, data, mb_send_buf, &ctx.tx_idx);
            break;
        case LWMB_FUNC_READ_HOLD_REGS:
            reg_addr  = (proc_buffer[2] << 8) | proc_buffer[3];
            reg_count = (proc_buffer[4] << 8) | proc_buffer[5];
            data      = &proc_buffer[6];
            res       = lwmb_read_holding_regs(addr, reg_addr, reg_count, data, mb_send_buf, &ctx.tx_idx);
            break;
        case LWMB_FUNC_WRITE_SINGLE_REGS:
            reg_addr = (proc_buffer[2] << 8) | proc_buffer[3];
            data     = &proc_buffer[4];
            res      = lwmb_write_single_reg(addr, reg_addr, (data[0] << 8) | data[1], mb_send_buf, &ctx.tx_idx);
            break;
        case LWMB_FUNC_WRITE_MULTIPLE_REGS:
            reg_addr  = (proc_buffer[2] << 8) | proc_buffer[3];
            reg_count = (proc_buffer[4] << 8) | proc_buffer[5];
            data      = &proc_buffer[7];
            res       = lwmb_write_multiple_regs(addr, reg_addr, reg_count, data, mb_send_buf, &ctx.tx_idx);
            break;
        case LWMB_FUNC_OSC_HANDSHAKE:
            data = proc_buffer + 2; // 跳过地址和功能码;
            res  = lwmb_osc_handshake(addr, data, proc_len - 4, mb_send_buf, &ctx.tx_idx);
            break;
        case LWMB_FUNC_OSC_START:
            data = proc_buffer + 2; // 跳过地址和功能码
            res  = lwmb_osc_start(addr, data, proc_len - 4, mb_send_buf, &ctx.tx_idx);
            break;
        case LWMB_FUNC_OSC_STOP:
            data                = proc_buffer + 2; // 跳过地址和功能码;
            res                 = lwmb_osc_stop(addr, data, proc_len - 4, mb_send_buf, &ctx.tx_idx);
            ctx.mb_reply_offset = -1;
            break;
        case LWMB_FUNC_OSC_SETCHN:
            data = proc_buffer + 2; // 跳过地址和功能码;
            res  = lwmb_osc_setchn(addr, data, proc_len - 4, mb_send_buf, &ctx.tx_idx);
            break;
        case LWMB_FUNC_OSC_SET_RATE:
            data = proc_buffer + 2; // 跳过地址和功能码;
            res  = lwmb_osc_set_rate(addr, data, proc_len - 4, mb_send_buf, &ctx.tx_idx);
            break;
        case LWMB_FUNC_OSC_HEART:
            data = proc_buffer + 2; // 跳过地址和功能码;
            res  = lwmb_osc_heart(addr, data, proc_len - 4, mb_send_buf, &ctx.tx_idx);
            break;
        default:
            res = LWMB_ERR_FUNC;
            break;
        }
        if (res == LWMB_OK)
        {
            // 计算CRC
            uint16_t response_crc = crc16(mb_send_buf, ctx.tx_idx);
            // 添加CRC到响应
            mb_send_buf[ctx.tx_idx++] = response_crc & 0xFF;        // CRC低字节
            mb_send_buf[ctx.tx_idx++] = (response_crc >> 8) & 0xFF; // CRC高字节
            lwmb_mark_mb_tx(mb_send_buf, ctx.tx_idx);               // 启动发送
        }
        else if (res == LWMB_OK_NO_REPLY)
        {
            // 如果没有回复，则不发送数据
            ctx.tx_idx = 0; // 清除发送索引
        }
        else
        {
            lwmb_build_error_response(mb_send_buf, func, res);
            ctx.tx_idx = 3; // 错误响应长度
            // 计算错误响应CRC
            uint16_t error_crc        = crc16(mb_send_buf, ctx.tx_idx);
            mb_send_buf[ctx.tx_idx++] = error_crc & 0xFF;        // CRC低字节
            mb_send_buf[ctx.tx_idx++] = (error_crc >> 8) & 0xFF; // CRC高字节
            lwmb_mark_mb_tx(mb_send_buf, ctx.tx_idx);            // 启动发送
        }
    }
}

void lwmb_start()
{
    // 启动接收帧
    lwmb_start_recv_frame(lwmb_get_idle_rx_buf(), LWMB_RX_MAX_LENGTH, lwmb_rx_frame_callback, lwmb_rx_frame_error_callback);
}

void lwmb_tick(uint32_t elapsed_us)
{
    if (ctx.state == STATE_RX)
    {
        ctx.last_rx_time += elapsed_us;
        if (ctx.last_rx_time > LWMB_FRAME_TIMEOUT_US)
        {
            ctx.state = STATE_RX_END; // 仅设置状态，不处理帧
        }
    }
}

// 轮询处理函数
void lwmb_poll(void)
{
#if !LWMB_FRAME_MODE
    // 流模式处理
    // 检查是否有新数据
    if (ctx.state == STATE_IDLE && ctx.rx_idx == 0)
    {
        ctx.rx_idx = 0;        // 重置接收索引
        ctx.state  = STATE_RX; // 设置状态为接收中
    }

    if (ctx.state == STATE_RX && ctx.rx_idx < LWMB_RX_MAX_LENGTH)
    {
        // 检查接收缓冲区是否有数据
        uint16_t available = lwmb_get_stream_avaliable_data();
        if (available > 0)
        {
            uint8_t  data[available];
            uint16_t data_read = lwmb_read_stream(data, available); // 从流中读取数据
            process_stream(data, data_read);
        }
    }
#endif

    // 帧处理，如果当前状态为接收结束，且上一帧已发送完成
    if (ctx.state == STATE_RX_END)
    {
        if (!ctx.mb_send_ready)
        {
            if (ctx.rx_idx >= 4)
            {
                check_complete_frame();
            }
            // 处理完成或错误后，重置接收状态
            ctx.rx_idx = 0;
            ctx.state  = STATE_IDLE;
        }
        else
        {
            // 上一帧未完成发送则等待下次轮询处理
        }
    }
    if (!ctx.osc_mode)
    {
        // 示波模式下数据合并至osc发送，该位置不需要发送
        lwmb_start_tx_mb(); // 启动modbus发送
    }
}

// 初始化双缓冲
void lwmb_init(void)
{
    ctx.active_tx_buf                             = ctx.tx_buf_a;
    ctx.active_rx_buf                             = ctx.rx_buf_a;
    ctx.active_tx_mb_buf                          = ctx.active_tx_buf + LWMB_OSC_BUFFER_SIZE; // Modbus数据区
    ctx.mb_send_ready                             = 0;
    ctx.osc_mode                                  = 0;
    ctx.rx_idx                                    = 0;
    ctx.tx_idx                                    = 0;
    ctx.osc_data_index                            = LWMB_OSC_BUFFER_DATA_START;
    ctx.tx_buf_a[0]                               = 0xff;
    ctx.tx_buf_b[0]                               = 0xff;
    ctx.tx_buf_a[1]                               = 0x77;
    ctx.tx_buf_b[1]                               = 0x77;
    ctx.tx_buf_a[2]                               = 0xAA;
    ctx.tx_buf_b[2]                               = 0xAA;
    ctx.tx_buf_a[3]                               = 0x55;
    ctx.tx_buf_b[3]                               = 0x55;
    ctx.tx_buf_a[LWMB_OSC_BUFFER_SIZE_NO_LEN - 4] = 0xff;
    ctx.tx_buf_b[LWMB_OSC_BUFFER_SIZE_NO_LEN - 4] = 0xff;
    ctx.tx_buf_a[LWMB_OSC_BUFFER_SIZE_NO_LEN - 3] = 0x77;
    ctx.tx_buf_b[LWMB_OSC_BUFFER_SIZE_NO_LEN - 3] = 0x77;
    ctx.tx_buf_a[LWMB_OSC_BUFFER_SIZE_NO_LEN - 2] = 0xAA;
    ctx.tx_buf_b[LWMB_OSC_BUFFER_SIZE_NO_LEN - 2] = 0xAA;
    ctx.tx_buf_a[LWMB_OSC_BUFFER_SIZE_NO_LEN - 1] = 0x55;
    ctx.tx_buf_b[LWMB_OSC_BUFFER_SIZE_NO_LEN - 1] = 0x55;
    for (int i = 0; i < LWMB_OSC_MAX_CHANNEL; i++)
    {
        osc_channels[i].page     = (((uint32_t)osc_channels) >> 16);
        osc_channels[i].index    = 0;
        osc_channels[i].paraType = LWMB_OSC_PARA_TYPE_ABS_INT16;
    }
    ctx.osc_sample_tick     = 0;
    ctx.osc_sample_tick_max = 1;
}

// UART发送完成回调(由UART驱动调用)
static void uart_tx_complete(void)
{
    ctx.mb_send_ready = 0;
}

static void lwmb_rx_frame_callback(uint8_t *data, uint16_t len)
{
    // 设置idx为数据长度
    ctx.rx_idx = len;
    // 交换缓冲区
    ctx.active_rx_buf = lwmb_get_idle_rx_buf();
    // 设置状态为接收结束
    ctx.state = STATE_RX_END;
    // 接收数据到idle缓冲区
    lwmb_start_recv_frame(lwmb_get_idle_rx_buf(), LWMB_RX_MAX_LENGTH, lwmb_rx_frame_callback, lwmb_rx_frame_error_callback);
}

static void lwmb_rx_frame_error_callback(void)
{
    // 接收错误处理
    ctx.rx_idx = 0;
    ctx.state  = STATE_IDLE;
    // 重置接收
    lwmb_reset_recv_frame(); // 重置接收状态

    // 重新启动接收
    lwmb_start_recv_frame(lwmb_get_idle_rx_buf(), LWMB_RX_MAX_LENGTH, lwmb_rx_frame_callback, lwmb_rx_frame_error_callback);
}

// Modbus命令

lwmb_err_t lwmb_read_input_regs(uint8_t addr, uint16_t reg_addr, uint16_t reg_count, uint8_t *data, uint8_t *reply_data, uint16_t *reply_len)
{
    reply_data[0] = addr;                      // 从地址
    reply_data[1] = LWMB_FUNC_READ_INPUT_REGS; // 功能码
    reply_data[2] = reg_count * 2;             // 数据字节数
    *reply_len    = 3 + reg_count * 2;         // 3字节头 + 数据字节数
    for (int i = 0; i < reg_count; i++)
    {
        uint16_t current_reg_addr = reg_addr + i;
        switch (current_reg_addr)
        {
        case LWMB_OSC_FRAME_LEN_ADDR:
            reply_data[3 + i * 2]     = (LWMB_OSC_BUFFER_SIZE_NO_LEN >> 8) & 0xFF; // 高字节
            reply_data[3 + i * 2 + 1] = LWMB_OSC_BUFFER_SIZE_NO_LEN & 0xFF;        // 低字节
            break;
        case LWMB_OSC_FRAME_CHN_ADDR:
            reply_data[3 + i * 2]     = 0;
            reply_data[3 + i * 2 + 1] = LWMB_OSC_MAX_CHANNEL; // 通道数
            break;
        case LWMB_OSC_RATE_ADDR:
        case LWMB_OSC_RATE_ADDR_COMPTAITABLE:
            reply_data[3 + i * 2]     = ((uint16_t)(LWMB_OSC_SAMPLE_RATE / ctx.osc_sample_tick_max) >> 8) & 0xFF; // 高字节
            reply_data[3 + i * 2 + 1] = (uint16_t)(LWMB_OSC_SAMPLE_RATE / ctx.osc_sample_tick_max) & 0xFF;        // 低字节
            break;
        default:
            return LWMB_ERR_FUNC; // 如果寄存器地址不支持，返回错误
        }
    }
    return LWMB_OK; // 返回成功
}

lwmb_err_t lwmb_read_holding_regs(uint8_t addr, uint16_t reg_addr, uint16_t reg_count, uint8_t *data, uint8_t *reply_data, uint16_t *reply_len)
{

#if defined(SYS_ENABLE_MONITOR_PARA_MGR)
    uint8_t page = reg_addr >> 8;
    uint8_t para = reg_addr & 0xFF;

    uint32_t           paraValue = 0;
    SYS_PARA_WR_RESULT res       = Success;

    if ((reg_addr == 0x12 || reg_addr == 0xFFFE) && reg_count == 2)
    {
        // 特殊寄存器0x12/0xFFFE，返回设备ID，暂时为0xFF
        reply_data[3] = LWMB_VER_MAJOR << 4 | LWMB_VER_MINOR;
        reply_data[4] = 0xFF;
        reply_data[5] = 0xFF;
        reply_data[6] = 0xFF;
    }
    else
    {
        for (int i = 0; i < reg_count; i++)
        {
            res = SysParaRead(SysParaPageId2Index(page), para + i, &paraValue); // 读取系统参数
            if (res != Success)
            {
                return LWMB_ERR_FUNC; // 如果读取失败，返回错误
            }
            reply_data[3 + i * 2]     = (paraValue >> 8) & 0xFF; // 高字节
            reply_data[3 + i * 2 + 1] = paraValue & 0xFF;        // 低字节
        }
    }
#else
    // 如果没有启用参数管理，直接返回错误，自定义逻辑在此处实
    if (lwmb_custom_rw_callback)
    {
        for (int i = 0; i < reg_count; i++)
        {
            uint16_t value = 0;
            lwmb_custom_rw_callback(reg_addr + i, &value, 0); // 调用自定义回调函数
            reply_data[3 + i * 2]     = (value >> 8) & 0xFF;  // 高字节
            reply_data[3 + i * 2 + 1] = value & 0xFF;         // 低字节
        }
    }
#endif

    *reply_len = 3 + reg_count * 2; // 3字节头 + 数据字节数

    // 发送响应
    *reply_len    = 3 + reg_count * 2;
    reply_data[0] = addr;                     // 从地址
    reply_data[1] = LWMB_FUNC_READ_HOLD_REGS; // 功能码
    reply_data[2] = reg_count * 2;            // 数据字节数
    return LWMB_OK;
}

lwmb_err_t lwmb_write_single_reg(uint8_t addr, uint16_t reg_addr, uint16_t value, uint8_t *reply_data, uint16_t *reply_len)
{
#if defined(SYS_ENABLE_MONITOR_PARA_MGR)
    uint8_t page = reg_addr >> 8;
    uint8_t para = reg_addr & 0xFF;

    uint32_t           paraValue;
    SYS_PARA_ATTR      paraAttr;
    SYS_PARA_WR_RESULT res;
    SysParaAttrRead(SysParaPageId2Index(page), para, &paraAttr.word);

    if (paraAttr.bit.Float == 0)
    {
        if (paraAttr.bit.Signed == 1)
        {
            int16_t value_real = *(int16_t *)&value;
            paraValue          = value_real;
        }
        else
        {
            paraValue = value;
        }
        res = SysParaWrite(SysParaPageId2Index(page), para, &paraValue);
    }
    else
    {
        res = WriteNotAllowed;
    }

    if (res != Success)
    {
        return LWMB_ERR_FUNC; // 如果写入失败，返回错误
    }
#else
    // 如果没有启用参数管理，直接返回错误，自定义逻辑在此处实现
    if (lwmb_custom_rw_callback)
    {
        lwmb_custom_rw_callback(reg_addr, &value, 1); // 调用自定义回调函数
    }
#endif

    *reply_len    = 6;                           // 1字节地址 + 1字节功能码 + 2字节寄存器地址 + 2字节值
    reply_data[0] = addr;                        // 从地址
    reply_data[1] = LWMB_FUNC_WRITE_SINGLE_REGS; // 功能码
    reply_data[2] = (reg_addr >> 8) & 0xFF;      // 寄存器地址高字节
    reply_data[3] = reg_addr & 0xFF;             // 寄存器地址低字节
    reply_data[4] = (value >> 8) & 0xFF;         // 值高字节
    reply_data[5] = value & 0xFF;                // 值低字节

    return LWMB_OK;
}

lwmb_err_t lwmb_write_multiple_regs(uint8_t addr, uint16_t reg_addr, uint16_t reg_count, const uint8_t *data, uint8_t *reply_data,
                                    uint16_t *reply_len)
{
#if defined(SYS_ENABLE_MONITOR_PARA_MGR)
    uint8_t            page = reg_addr >> 8;
    uint8_t            para = reg_addr & 0xFF;
    SYS_PARA_WR_RESULT res  = Success;

    for (int i = 0; i < reg_count; i++)
    {
        uint16_t value     = (data[i * 2] << 8) | data[i * 2 + 1]; // 高字节在前
        uint32_t paraValue = value;
        res                = SysParaWrite(SysParaPageId2Index(page), para + i, &paraValue); // 写入系统参数
        if (res != Success)
        {
            return LWMB_ERR_FUNC; // 如果写入失败，返回错误
        }
    }
#else
    // 如果没有启用参数管理，直接返回错误，自定义逻辑在此处实现
    if (lwmb_custom_rw_callback)
    {
        for (int i = 0; i < reg_count; i++)
        {
            uint16_t value = (data[i * 2] << 8) | data[i * 2 + 1]; // 高字节在前
            lwmb_custom_rw_callback(reg_addr + i, &value, 1);      // 调用自定义回调函数
        }
    }
#endif

    *reply_len    = 7;                             // 1字节地址 + 1字节功能码 + 2字节起始地址 + 2字节寄存器数量 + 1字节字节数
    reply_data[0] = addr;                          // 从地址
    reply_data[1] = LWMB_FUNC_WRITE_MULTIPLE_REGS; // 功能码
    reply_data[2] = (reg_addr >> 8) & 0xFF;        // 起始地址高字节
    reply_data[3] = reg_addr & 0xFF;               // 起始地址低字节
    reply_data[4] = (reg_count >> 8) & 0xFF;       // 寄存器数量高字节
    reply_data[5] = reg_count & 0xFF;              // 寄存器数量低字节
    reply_data[6] = reg_count * 2;                 // 数据字节数
    return LWMB_OK;
}

lwmb_err_t lwmb_osc_handshake(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len)
{
    // 处理握手逻辑
    // 这里可以根据需要实现握手逻辑
    *reply_len    = 3;                       // 1字节地址 + 1字节功能码 + 1字节状态
    reply_data[0] = addr;                    // 从地址
    reply_data[1] = LWMB_FUNC_OSC_HANDSHAKE; // 功能码
    reply_data[2] = 0x00;                    // 状态，0表示成功
    return LWMB_OK;
}

lwmb_err_t lwmb_osc_start(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len)
{
    // 处理开始逻辑
    lwmb_start_osc_mode(); // 启动示波模式

    *reply_len     = 6;                   // 1字节地址 + 1字节功能码 + 1字节状态
    reply_data[-1] = 0x08;                // 示波模式下额外设置modbus帧长
    reply_data[0]  = addr;                // 从地址
    reply_data[1]  = LWMB_FUNC_OSC_START; // 功能码
    reply_data[2]  = 0x00;
    reply_data[3]  = 0x00;
    reply_data[4]  = 0x00;
    reply_data[5]  = 0x00;
    return LWMB_OK;
}

lwmb_err_t lwmb_osc_stop(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len)
{
    // 处理停止逻辑
    lwmb_stop_osc_mode(); // 停止示波模式

    *reply_len     = 6;                  // 1字节地址 + 1字节功能码 + 1字节状态
    reply_data[-1] = 0x08;               // 示波模式下额外设置modbus帧长
    reply_data[0]  = addr;               // 从地址
    reply_data[1]  = LWMB_FUNC_OSC_STOP; // 功能码
    reply_data[2]  = 0x00;
    reply_data[3]  = 0x00;
    reply_data[4]  = 0x00;
    reply_data[5]  = 0x00;
    return LWMB_OK;
}

lwmb_err_t lwmb_osc_setchn(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len)
{
    // 处理设置通道逻辑
    uint8_t  channel   = raw_data[0];                      // 假设第一个字节是通道号
    uint8_t  para_type = raw_data[1];                      // 假设第二个字节是参数类型
    uint16_t para_addr = (raw_data[2] << 8) | raw_data[3]; // 假设后续字节是地址

    if (!lwmb_check_valid_osc_addr(para_addr, (lwmb_osc_para_type_t)para_type))
    {
        return LWMB_ERR_FUNC; // 如果地址或参数类型无效，返回错误
    }

    switch (para_type)
    {
    case LWMB_OSC_PARA_TYPE_DEFAULT:
    case LWMB_OSC_PARA_TYPE_ABS_INT16:
    case LWMB_OSC_PARA_TYPE_ABS_INT8: // 8bit数据仍然占用一个通道，按16bit数据处理
#ifdef SYS_MONITOR_OSC_FLOAT_SUPPORT
    case LWMB_OSC_PARA_TYPE_ABS_FLOAT_TO_Q14:
    case LWMB_OSC_PARA_TYPE_ABS_FLOAT_X_1000:
#endif
        ctx.osc_occupied_channel += 1;
        ctx.osc_real_channel += 1;
        break;
    case LWMB_OSC_PARA_TYPE_ABS_INT32_FLOAT:
        ctx.osc_occupied_channel += 2; // 32位整型/浮点型占用2个通道
        ctx.osc_real_channel += 1;
        break;
    case LWMB_OSC_PARA_TYPE_ABS_INT64_DOUBLE:
        ctx.osc_occupied_channel += 4; // 64位整型/浮点型占用4个通道
        ctx.osc_real_channel += 1;
        break;
    }

    osc_channels[channel - 1].paraType = para_type; // 设置通道参数类型

    if (ctx.osc_occupied_channel <= LWMB_OSC_MAX_CHANNEL)
    {
        // TODO：校验地址合法性
        int8_t addr_valid = 0;
#if defined(__TMS320C28XX__)
        switch (para_type)
        {
        case LWMB_OSC_PARA_TYPE_DEFAULT:
        case LWMB_OSC_PARA_TYPE_ABS_INT16:
        case LWMB_OSC_PARA_TYPE_ABS_INT8:
            addr_valid = 1;
            break;
        case LWMB_OSC_PARA_TYPE_ABS_INT32_FLOAT:
#ifdef SYS_MONITOR_OSC_FLOAT_SUPPORT
        case LWMB_OSC_PARA_TYPE_ABS_FLOAT_TO_Q14:
        case LWMB_OSC_PARA_TYPE_ABS_FLOAT_X_1000:
#endif
            if ((para_addr & 0x01) == 0)
                addr_valid = 1;
            break;
        case LWMB_OSC_PARA_TYPE_ABS_INT64_DOUBLE:
            if ((para_addr & 0x01) == 0)
                addr_valid = 1;
            break;
        }
#else
        switch (para_type)
        {
        case LWMB_OSC_PARA_TYPE_ABS_INT8:
            addr_valid = 1;
            break;
        case LWMB_OSC_PARA_TYPE_DEFAULT:
        case LWMB_OSC_PARA_TYPE_ABS_INT16:
            if ((para_addr & 0x01) == 0)
                addr_valid = 1;
            break;
        case LWMB_OSC_PARA_TYPE_ABS_INT32_FLOAT:
#ifdef SYS_MONITOR_OSC_FLOAT_SUPPORT
        case LWMB_OSC_PARA_TYPE_ABS_FLOAT_TO_Q14:
        case LWMB_OSC_PARA_TYPE_ABS_FLOAT_X_1000:
#endif
            if ((para_addr & 0x03) == 0)
                addr_valid = 1;
            break;
        case LWMB_OSC_PARA_TYPE_ABS_INT64_DOUBLE:
            if ((para_addr & 0x07) == 0)
                addr_valid = 1;
            break;
        }
#endif
        if (addr_valid)
        {
            osc_channels[channel - 1].index = para_addr; // 设置索引
        }
        else
        {
            goto CHANNEL_ADDR_CHECK_ERR;
        }
    }
    else
    {
    CHANNEL_ADDR_CHECK_ERR:
        ctx.osc_occupied_channel = 0; // 如果通道数超过最大限制，重置使用的通道数
        ctx.osc_real_channel     = 0;
        return LWMB_ERR_FUNC; // 返回错误
    }

    ctx.osc_sample_tick_max = lwmb_osc_calc_sample_tick(ctx.osc_occupied_channel, 0); // 计算新的采样间隔

    *reply_len    = len + 2;               // 1字节地址 + 1字节功能码 + 原始数据长度
    reply_data[0] = addr;                  // 从地址
    reply_data[1] = LWMB_FUNC_OSC_SETCHN;  // 功能码
    memcpy(&reply_data[2], raw_data, len); // 复制原始数据到回复数据
    // 假设通道设置成功
    return LWMB_OK;
}

lwmb_err_t lwmb_osc_set_rate(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len)
{
    // 0x73帧：[addr, 0x73, bitsPerSec(4字节 big-endian), CRC]
    // 上位机用该命令限制示波数据传输速率，MCU据此调整采样间隔
    if (len < 4)
    {
        return LWMB_ERR_FRAME; // 数据长度不足
    }

    uint32_t bits_per_sec = ((uint32_t)raw_data[0] << 24) |
                             ((uint32_t)raw_data[1] << 16) |
                             ((uint32_t)raw_data[2] << 8)  |
                             (uint32_t)raw_data[3];

    if (bits_per_sec > 0)
    {
        // 串口每字节 10 bit（1 起始位 + 8 数据位 + 1 停止位），换算为 bytes/s，负载50%
        uint32_t bytes_per_sec = bits_per_sec / 10 / 2;
        ctx.osc_sample_tick_max = lwmb_osc_calc_sample_tick(ctx.osc_occupied_channel, bytes_per_sec);
    }

    // 回复：回显原始数据（同 setchn 风格）
    *reply_len    = len + 2;                   // addr + func + raw_data
    reply_data[0] = addr;                      // 从地址
    reply_data[1] = LWMB_FUNC_OSC_SET_RATE;    // 功能码
    memcpy(&reply_data[2], raw_data, len);     // 回显数据
    return LWMB_OK;
}

lwmb_err_t lwmb_osc_heart(uint8_t addr, uint8_t *raw_data, uint16_t len, uint8_t *reply_data, uint16_t *reply_len)
{
    *reply_len     = 6;                   // 1字节地址 + 1字节功能码 + 4字节填充
    reply_data[-1] = 0x08;                // 示波模式下额外设置modbus帧长
    reply_data[0]  = addr;                // 从地址
    reply_data[1]  = LWMB_FUNC_OSC_HEART; // 功能码
    reply_data[2]  = 0x00;
    reply_data[3]  = 0x00;
    reply_data[4]  = 0x00;
    reply_data[5]  = 0x00;
    return LWMB_OK;
}
