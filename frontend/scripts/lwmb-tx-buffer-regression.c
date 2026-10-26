#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../reference/mcu_code/lwmb.c"

static void test_parameter_access(uint16_t id, uint16_t *value, int8_t is_write)
{
    if (!is_write)
    {
        *value = id;
    }
}

void lwmb_start_recv_frame(uint8_t *buf, uint16_t len, void (*cplt)(uint8_t *data, uint16_t len), void (*error)())
{
    (void)buf;
    (void)len;
    (void)cplt;
    (void)error;
}

void lwmb_reset_recv_frame(void)
{
}

void lwmb_send_data(uint8_t *data, uint16_t len)
{
    (void)data;
    (void)len;
}

bool lwmb_check_valid_osc_addr(uint16_t addr_low, lwmb_osc_para_type_t type)
{
    (void)addr_low;
    (void)type;
    return true;
}

static void build_read_request(uint16_t count)
{
    uint8_t *request = ctx.rx_buf_a;
    request[0] = 0xff;
    request[1] = LWMB_FUNC_READ_HOLD_REGS;
    request[2] = 0x07;
    request[3] = 0x00;
    request[4] = (uint8_t)(count >> 8);
    request[5] = (uint8_t)count;

    uint16_t crc = lwmb_crc16(request, 6);
    request[6] = (uint8_t)crc;
    request[7] = (uint8_t)(crc >> 8);
    ctx.active_rx_buf = request;
    ctx.rx_idx = 8;
}

static bool has_osc_header(const uint8_t *buf)
{
    static const uint8_t expected[] = {0xff, 0x77, 0xaa, 0x55};
    return memcmp(buf, expected, sizeof(expected)) == 0;
}

static int run_read_case(uint16_t count, uint16_t expected_response_len)
{
    memset(&ctx, 0, sizeof(ctx));
    lwmb_init();
    lwmb_custom_rw_callback = test_parameter_access;
    build_read_request(count);
    check_complete_frame();

    if (ctx.tx_idx != expected_response_len)
    {
        fprintf(stderr, "count=%u response length=%u, expected=%u\n", count, ctx.tx_idx, expected_response_len);
        return 1;
    }
    if (!has_osc_header(ctx.tx_buf_a) || !has_osc_header(ctx.tx_buf_b))
    {
        fprintf(stderr,
                "count=%u corrupted headers: A=%02x%02x%02x%02x B=%02x%02x%02x%02x\n",
                count,
                ctx.tx_buf_a[0], ctx.tx_buf_a[1], ctx.tx_buf_a[2], ctx.tx_buf_a[3],
                ctx.tx_buf_b[0], ctx.tx_buf_b[1], ctx.tx_buf_b[2], ctx.tx_buf_b[3]);
        return 1;
    }
    return 0;
}

int main(void)
{
    if (run_read_case(58, 121) != 0)
    {
        return 1;
    }
    if (run_read_case(125, 255) != 0)
    {
        return 1;
    }
    if (run_read_case(126, 5) != 0)
    {
        return 1;
    }

    puts("lwmb TX buffers preserve both oscilloscope headers");
    return 0;
}
