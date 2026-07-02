#include "router_service.h"

#include "comm_stats.h"
#include "esp_log.h"

static const char *TAG = "router_service";

const char *router_mode_name(router_mode_t mode)
{
    switch (mode) {
    case ROUTER_MODE_BLE:
        return "BLE";
    case ROUTER_MODE_WIFI:
        return "WIFI";
    case ROUTER_MODE_IDLE:
    default:
        return "IDLE";
    }
}

static void router_send_or_log(router_mode_t mode, router_send_fn_t send,
                               const uint8_t *data, size_t len)
{
    if (send == NULL) {
        ESP_LOGW(TAG, "%s route unavailable, dropping len=%u",
                 router_mode_name(mode), (unsigned)len);
        comm_stats_route_unavailable_drop(len);
        return;
    }

    size_t sent = send(data, len);
    if (sent < len) {
        ESP_LOGW(TAG, "%s dropped tail, sent=%u/%u",
                 router_mode_name(mode), (unsigned)sent, (unsigned)len);
        comm_stats_route_partial_drop(len - sent);
    }
}

void router_dispatch_uart_frame(const router_context_t *ctx, const uint8_t *data, size_t len)
{
    if (ctx == NULL || data == NULL || len == 0) {
        return;
    }

    router_mode_t mode = ctx->current_mode;
    if (mode == ROUTER_MODE_IDLE) {
        if (ctx->wifi_available) {
            mode = ROUTER_MODE_WIFI;
        } else if (ctx->ble_available) {
            mode = ROUTER_MODE_BLE;
        }

        if (mode == ROUTER_MODE_IDLE) {
            ESP_LOGW(TAG, "UART data received in IDLE mode, dropping.");
            comm_stats_route_idle_drop(len);
            return;
        }

        ESP_LOGI(TAG, "<<<<< Auto mode switched to %s >>>>>", router_mode_name(mode));
        if (ctx->set_mode != NULL) {
            ctx->set_mode(mode, ctx->set_mode_ctx);
        }
    }

    if (mode == ROUTER_MODE_WIFI) {
        router_send_or_log(mode, ctx->send_wifi, data, len);
    } else if (mode == ROUTER_MODE_BLE) {
        router_send_or_log(mode, ctx->send_ble, data, len);
    }
}
