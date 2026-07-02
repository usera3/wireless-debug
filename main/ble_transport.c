#include "ble_transport.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "comm_stats.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "host/ble_att.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#ifndef MIN
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#endif

#define BLE_SVC_SPP_UUID16     0xABF0
#define BLE_SVC_SPP_CHR_UUID16 0xABF1

#ifndef BLE_NOTIFY_CHUNK_SIZE
#if defined(CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU) && (CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU > 23)
#define BLE_NOTIFY_CHUNK_SIZE (CONFIG_BT_NIMBLE_ATT_PREFERRED_MTU - 3)
#else
#define BLE_NOTIFY_CHUNK_SIZE 20
#endif
#endif

#define BLE_NOTIFY_SAFE_CHUNK_SIZE 20

static const char *TAG = "ble_transport";

static ble_transport_config_t s_config;
static uint8_t s_own_addr_type;
static bool s_conn_handle_subs[CONFIG_BT_NIMBLE_MAX_CONNECTIONS + 1];
static uint16_t s_gatt_read_val_handle;
static SemaphoreHandle_t s_start_mutex;
static bool s_started;

static void ble_spp_server_advertise(void);
static int ble_spp_server_gap_event(struct ble_gap_event *event, void *arg);

static void report_ready(bool ready)
{
    if (s_config.on_ready != NULL) {
        s_config.on_ready(ready, s_config.ctx);
    }
}

static void report_status(const char *status)
{
    if (s_config.on_status != NULL) {
        s_config.on_status(status, s_config.ctx);
    }
}

static void log_heap(const char *label)
{
    if (s_config.log_heap != NULL) {
        s_config.log_heap(label, s_config.ctx);
    }
}

static void print_addr(const void *addr)
{
    const uint8_t *u8p = addr;
    ESP_LOGI(TAG, "%02x:%02x:%02x:%02x:%02x:%02x",
             u8p[5], u8p[4], u8p[3], u8p[2], u8p[1], u8p[0]);
}

static void ble_spp_server_on_reset(int reason)
{
    ESP_LOGE(TAG, "Resetting state; reason=%d", reason);
    report_ready(false);
}

static void ble_spp_server_on_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    assert(rc == 0);

    rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "error determining address type; rc=%d", rc);
        return;
    }

    uint8_t addr_val[6] = {0};
    rc = ble_hs_id_copy_addr(s_own_addr_type, addr_val, NULL);
    ESP_LOGI(TAG, "BLE Device Address: ");
    print_addr(addr_val);

    char ble_name[32];
    snprintf(ble_name, sizeof(ble_name), "NimBLE_%02X%02X", addr_val[1], addr_val[0]);
    rc = ble_svc_gap_device_name_set(ble_name);
    (void)rc;

    ble_spp_server_advertise();
}

static void ble_spp_server_advertise(void)
{
    struct ble_gap_adv_params adv_params;
    struct ble_hs_adv_fields fields;
    int rc;

    memset(&fields, 0, sizeof fields);
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.tx_pwr_lvl_is_present = 1;
    fields.tx_pwr_lvl = BLE_HS_ADV_TX_PWR_LVL_AUTO;

    const char *name = ble_svc_gap_device_name();
    fields.name = (uint8_t *)name;
    fields.name_len = strlen(name);
    fields.name_is_complete = 1;

    fields.uuids16 = (ble_uuid16_t[]) { BLE_UUID16_INIT(BLE_SVC_SPP_UUID16) };
    fields.num_uuids16 = 1;
    fields.uuids16_is_complete = 1;

    rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "error setting advertisement data; rc=%d", rc);
        return;
    }

    memset(&adv_params, 0, sizeof adv_params);
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER,
                           &adv_params, ble_spp_server_gap_event, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "error enabling advertisement; rc=%d", rc);
        return;
    }
    report_ready(true);
    report_status("ble_adv");
}

static bool ble_conn_handle_valid(uint16_t conn_handle)
{
    return conn_handle < (sizeof(s_conn_handle_subs) / sizeof(s_conn_handle_subs[0]));
}

static void ble_set_subscription(uint16_t conn_handle, bool subscribed)
{
    if (!ble_conn_handle_valid(conn_handle)) {
        ESP_LOGW(TAG, "BLE conn_handle out of range: %u", conn_handle);
        return;
    }
    s_conn_handle_subs[conn_handle] = subscribed;
}

static int ble_notify_chunk(uint16_t conn_handle, const uint8_t *data, size_t len)
{
    struct os_mbuf *txom = ble_hs_mbuf_from_flat(data, len);
    if (txom == NULL) {
        comm_stats_ble_alloc_failure();
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return ble_gatts_notify_custom(conn_handle, s_gatt_read_val_handle, txom);
}

static size_t ble_notify_payload_size(uint16_t conn_handle)
{
    uint16_t mtu = ble_att_mtu(conn_handle);
    if (mtu <= 3) {
        return BLE_NOTIFY_SAFE_CHUNK_SIZE;
    }

    size_t payload_size = (size_t)mtu - 3;
    size_t configured_limit = BLE_NOTIFY_CHUNK_SIZE;
    if (configured_limit == 0) {
        configured_limit = BLE_NOTIFY_SAFE_CHUNK_SIZE;
    }
    return MIN(payload_size, configured_limit);
}

static size_t ble_notify_connection(uint16_t conn_handle, const uint8_t *data, size_t len)
{
    size_t sent = 0;
    size_t chunk_size = ble_notify_payload_size(conn_handle);
    if (chunk_size == 0) {
        chunk_size = BLE_NOTIFY_SAFE_CHUNK_SIZE;
    }

    while (sent < len) {
        size_t chunk_len = MIN(len - sent, chunk_size);
        int rc = ble_notify_chunk(conn_handle, data + sent, chunk_len);
        if (rc == 0) {
            sent += chunk_len;
            comm_stats_ble_tx_bytes(chunk_len);
            continue;
        }

        if (chunk_size > BLE_NOTIFY_SAFE_CHUNK_SIZE) {
            ESP_LOGD(TAG, "BLE notify chunk=%u failed rc=%d, retrying with %u",
                     (unsigned)chunk_size, rc, (unsigned)BLE_NOTIFY_SAFE_CHUNK_SIZE);
            chunk_size = BLE_NOTIFY_SAFE_CHUNK_SIZE;
            continue;
        }

        ESP_LOGW(TAG, "BLE notify failed conn=%u rc=%d sent=%u/%u",
                 conn_handle, rc, (unsigned)sent, (unsigned)len);
        comm_stats_ble_notify_failure(len - sent);
        break;
    }

    return sent;
}

size_t ble_spp_transport_send(const uint8_t *data, size_t len)
{
    if (data == NULL || len == 0) {
        return 0;
    }

    size_t subscribers = 0;
    size_t min_sent = len;

    for (size_t i = 0; i < (sizeof(s_conn_handle_subs) / sizeof(s_conn_handle_subs[0])); i++) {
        if (!s_conn_handle_subs[i]) {
            continue;
        }
        subscribers++;
        size_t sent = ble_notify_connection((uint16_t)i, data, len);
        if (sent < min_sent) {
            min_sent = sent;
        }
    }

    if (subscribers == 0) {
        comm_stats_ble_no_subscriber_drop(len);
        return 0;
    }

    return min_sent;
}

static int ble_spp_server_gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        ESP_LOGI(TAG, "BLE connection %s; status=%d",
                 event->connect.status == 0 ? "established" : "failed",
                 event->connect.status);
        if (event->connect.status != 0 || CONFIG_BT_NIMBLE_MAX_CONNECTIONS > 1) {
            ble_spp_server_advertise();
        }
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "BLE disconnect; reason=%d", event->disconnect.reason);
        ble_set_subscription(event->disconnect.conn.conn_handle, false);
        ble_spp_server_advertise();
        return 0;

    case BLE_GAP_EVENT_SUBSCRIBE:
        ESP_LOGI(TAG, "BLE subscribe event; conn_handle=%d", event->subscribe.conn_handle);
        ble_set_subscription(event->subscribe.conn_handle, event->subscribe.cur_notify);
        return 0;

    default:
        return 0;
    }
}

static void ble_spp_server_host_task(void *param)
{
    (void)param;
    ESP_LOGI(TAG, "BLE Host Task Started");
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static int ble_svc_gatt_handler(uint16_t conn_handle, uint16_t attr_handle,
                                struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    switch (ctxt->op) {
    case BLE_GATT_ACCESS_OP_WRITE_CHR: {
        uint16_t data_len = OS_MBUF_PKTLEN(ctxt->om);
        if (data_len > 0) {
            uint8_t *data = malloc(data_len);
            if (data == NULL) {
                comm_stats_ble_alloc_failure();
                return BLE_ATT_ERR_INSUFFICIENT_RES;
            }

            os_mbuf_copydata(ctxt->om, 0, data_len, data);
            comm_stats_ble_rx_frame(data_len);
            ESP_LOGI(TAG, "BLE Received data, length: %d", data_len);
            if (s_config.on_rx != NULL) {
                s_config.on_rx(data, data_len, s_config.ctx);
            }
            free(data);
        }
        break;
    }
    default:
        break;
    }
    return 0;
}

static const struct ble_gatt_svc_def s_ble_svc_gatt_defs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(BLE_SVC_SPP_UUID16),
        .characteristics = (struct ble_gatt_chr_def[])
        { {
                .uuid = BLE_UUID16_DECLARE(BLE_SVC_SPP_CHR_UUID16),
                .access_cb = ble_svc_gatt_handler,
                .val_handle = &s_gatt_read_val_handle,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_NOTIFY,
            }, {
                0,
            }
        },
    },
    {
        0,
    },
};

static int gatt_svr_init(void)
{
    ble_svc_gap_init();
    ble_svc_gatt_init();

    int rc = ble_gatts_count_cfg(s_ble_svc_gatt_defs);
    if (rc != 0) {
        return rc;
    }

    return ble_gatts_add_svcs(s_ble_svc_gatt_defs);
}

esp_err_t ble_spp_transport_init(const ble_transport_config_t *config)
{
    if (config == NULL || config->on_rx == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    s_config = *config;
    return ESP_OK;
}

esp_err_t ble_spp_transport_start(void)
{
    esp_err_t ret = ESP_OK;

    if (s_start_mutex == NULL) {
        s_start_mutex = xSemaphoreCreateMutex();
        if (s_start_mutex == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }

    if (xSemaphoreTake(s_start_mutex, pdMS_TO_TICKS(3000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    if (s_started) {
        xSemaphoreGive(s_start_mutex);
        return ESP_OK;
    }

    report_status("ble_start");
    log_heap("before BLE init");

    ret = nimble_port_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init NimBLE: %s", esp_err_to_name(ret));
        report_ready(false);
        report_status("ble_fail");
        xSemaphoreGive(s_start_mutex);
        return ret;
    }

    memset(s_conn_handle_subs, 0, sizeof(s_conn_handle_subs));

    ble_hs_cfg.reset_cb = ble_spp_server_on_reset;
    ble_hs_cfg.sync_cb = ble_spp_server_on_sync;

    ble_hs_cfg.sm_io_cap = 0;
    ble_hs_cfg.sm_bonding = 0;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 0;
    ble_hs_cfg.sm_our_key_dist = 0;
    ble_hs_cfg.sm_their_key_dist = 0;

    int rc = gatt_svr_init();
    if (rc != 0) {
        ESP_LOGE(TAG, "Failed to init GATT services: rc=%d", rc);
        report_ready(false);
        report_status("gatt_fail");
        (void)nimble_port_deinit();
        xSemaphoreGive(s_start_mutex);
        return ESP_FAIL;
    }

    nimble_port_freertos_init(ble_spp_server_host_task);
    s_started = true;
    log_heap("after BLE init");

    xSemaphoreGive(s_start_mutex);
    return ESP_OK;
}

bool ble_spp_transport_is_started(void)
{
    return s_started;
}

bool ble_spp_transport_has_subscribers(void)
{
    for (size_t i = 0; i < (sizeof(s_conn_handle_subs) / sizeof(s_conn_handle_subs[0])); i++) {
        if (s_conn_handle_subs[i]) {
            return true;
        }
    }
    return false;
}
