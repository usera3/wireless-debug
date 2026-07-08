#include "cloud_mqtt.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "mqtt_client.h"

#define CLOUD_MQTT_STATUS_INTERVAL_US (5LL * 1000LL * 1000LL)
#define CLOUD_MQTT_TOPIC_MAX_LEN 96
#define CLOUD_MQTT_TOPIC_STATUS_FMT "wireless-debug/%s/status"
#define CLOUD_MQTT_TOPIC_AVAILABILITY_FMT "wireless-debug/%s/availability"
#define CLOUD_MQTT_TOPIC_CMD_FMT "wireless-debug/%s/cmd"
#define CLOUD_MQTT_TOPIC_ACK_FMT "wireless-debug/%s/ack"

static const char *TAG = "cloud_mqtt";
static cloud_mqtt_config_t s_config;
static cloud_mqtt_runtime_t s_runtime;
static esp_mqtt_client_handle_t s_client;
static esp_timer_handle_t s_status_timer;
static bool s_initialized;
static bool s_started;
static bool s_connected;
static char s_status_topic[CLOUD_MQTT_TOPIC_MAX_LEN];
static char s_availability_topic[CLOUD_MQTT_TOPIC_MAX_LEN];
static char s_cmd_topic[CLOUD_MQTT_TOPIC_MAX_LEN];
static char s_ack_topic[CLOUD_MQTT_TOPIC_MAX_LEN];

static int make_topic(char *out, size_t out_size, const char *suffix)
{
    return snprintf(out, out_size, "wireless-debug/%s/%s", s_config.device_id, suffix);
}

static int make_topic_from_format(char *out, size_t out_size, const char *fmt)
{
    return snprintf(out, out_size, fmt, s_config.device_id);
}

static const char *net_mode_json_name(system_net_mode_t mode)
{
    switch (mode) {
    case SYSTEM_NET_STA:
        return "sta";
    case SYSTEM_NET_APSTA:
        return "apsta";
    case SYSTEM_NET_AP:
    default:
        return "ap";
    }
}

static const char *comm_mode_json_name(app_comm_mode_t mode)
{
    switch (mode) {
    case APP_COMM_BLE:
        return "ble";
    case APP_COMM_WIFI:
        return "wifi";
    case APP_COMM_AUTO:
    default:
        return "auto";
    }
}

static void build_topics(void)
{
    make_topic_from_format(s_status_topic, sizeof(s_status_topic), CLOUD_MQTT_TOPIC_STATUS_FMT);
    make_topic_from_format(s_availability_topic, sizeof(s_availability_topic), CLOUD_MQTT_TOPIC_AVAILABILITY_FMT);
    make_topic_from_format(s_cmd_topic, sizeof(s_cmd_topic), CLOUD_MQTT_TOPIC_CMD_FMT);
    make_topic_from_format(s_ack_topic, sizeof(s_ack_topic), CLOUD_MQTT_TOPIC_ACK_FMT);
}

static void status_timer_cb(void *arg)
{
    (void)arg;
    cloud_mqtt_publish_status_now();
}

static void publish_ack(const char *command_id, const char *type, bool ok, const char *message)
{
    if (!s_connected || s_client == NULL) {
        return;
    }

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return;
    }
    cJSON_AddStringToObject(root, "device_id", s_config.device_id);
    cJSON_AddStringToObject(root, "command_id", command_id != NULL ? command_id : "");
    cJSON_AddBoolToObject(root, "ok", ok);
    cJSON_AddStringToObject(root, "type", type != NULL ? type : "");
    cJSON_AddStringToObject(root, "message", message != NULL ? message : "");

    char topic[96];
    make_topic(topic, sizeof(topic), "ack");
    char *payload = cJSON_PrintUnformatted(root);
    if (payload != NULL) {
        esp_mqtt_client_publish(s_client, topic, payload, 0, 1, 0);
        cJSON_free(payload);
    }
    cJSON_Delete(root);
}

static void handle_command(const char *payload, int payload_len)
{
    if (payload == NULL || payload_len <= 0) {
        publish_ack("", "", false, "empty command");
        return;
    }

    char *json = calloc((size_t)payload_len + 1U, 1U);
    if (json == NULL) {
        publish_ack("", "", false, "no memory");
        return;
    }
    memcpy(json, payload, (size_t)payload_len);

    cJSON *root = cJSON_Parse(json);
    free(json);
    if (root == NULL) {
        publish_ack("", "", false, "invalid json");
        return;
    }

    const cJSON *command_id = cJSON_GetObjectItem(root, "command_id");
    const cJSON *type = cJSON_GetObjectItem(root, "type");
    const char *command_id_text = cJSON_IsString(command_id) ? command_id->valuestring : "";
    const char *type_text = cJSON_IsString(type) ? type->valuestring : "";

    if (strcmp(type_text, "query_status") == 0) {
        cloud_mqtt_publish_status_now();
        publish_ack(command_id_text, type_text, true, "status published");
    } else if (strcmp(type_text, "set_wifi_mode") == 0 ||
               strcmp(type_text, "set_uart_baud") == 0 ||
               strcmp(type_text, "set_comm_mode") == 0 ||
               strcmp(type_text, "ble_start") == 0 ||
               strcmp(type_text, "display_text") == 0) {
        publish_ack(command_id_text, type_text, false, "command scaffold only");
    } else {
        publish_ack(command_id_text, type_text, false, "unsupported command type");
    }

    cJSON_Delete(root);
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    (void)handler_args;
    (void)base;
    esp_mqtt_event_handle_t event = event_data;

    if (event_id == MQTT_EVENT_CONNECTED) {
        s_connected = true;
        esp_mqtt_client_publish(s_client, s_availability_topic, "online", 0, 1, 1);
        esp_mqtt_client_subscribe(s_client, s_cmd_topic, 1);
        cloud_mqtt_publish_status_now();
    } else if (event_id == MQTT_EVENT_DISCONNECTED) {
        s_connected = false;
    } else if (event_id == MQTT_EVENT_DATA && event != NULL) {
        if ((int)strlen(s_cmd_topic) == event->topic_len &&
            strncmp(event->topic, s_cmd_topic, event->topic_len) == 0) {
            handle_command(event->data, event->data_len);
        }
    }
}

esp_err_t cloud_mqtt_init(const cloud_mqtt_config_t *config,
                          const cloud_mqtt_runtime_t *runtime)
{
    if (config == NULL || runtime == NULL || config->device_id == NULL ||
        config->mqtt_uri == NULL || config->device_id[0] == '\0' ||
        config->mqtt_uri[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    s_config = *config;
    s_runtime = *runtime;
    build_topics();

    if (!s_config.enabled) {
        s_initialized = true;
        return ESP_OK;
    }

    const esp_timer_create_args_t timer_args = {
        .callback = status_timer_cb,
        .name = "cloud_mqtt_status",
    };
    esp_err_t err = esp_timer_create(&timer_args, &s_status_timer);
    if (err != ESP_OK) {
        return err;
    }

    esp_mqtt_client_config_t mqtt_cfg = {
        .broker.address.uri = s_config.mqtt_uri,
        .session.last_will = {
            .topic = s_availability_topic,
            .msg = "offline",
            .msg_len = 7,
            .qos = 1,
            .retain = true,
        },
    };

    s_client = esp_mqtt_client_init(&mqtt_cfg);
    if (s_client == NULL) {
        return ESP_ERR_NO_MEM;
    }
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    s_initialized = true;
    ESP_LOGI(TAG, "cloud MQTT configured: id=%s uri=%s", s_config.device_id, s_config.mqtt_uri);
    return ESP_OK;
}

void cloud_mqtt_notify_wifi_state(const wifi_manager_status_t *status)
{
    if (!s_initialized || !s_config.enabled || s_client == NULL || status == NULL) {
        return;
    }

    bool should_run = status->mode != SYSTEM_NET_AP && status->sta_connected;
    if (should_run && !s_started) {
        s_started = true;
        esp_mqtt_client_start(s_client);
        if (s_status_timer != NULL) {
            esp_timer_start_periodic(s_status_timer, CLOUD_MQTT_STATUS_INTERVAL_US);
        }
    } else if (!should_run && s_started) {
        if (s_connected) {
            esp_mqtt_client_publish(s_client, s_availability_topic, "offline", 0, 1, 1);
        }
        if (s_status_timer != NULL) {
            esp_timer_stop(s_status_timer);
        }
        esp_mqtt_client_stop(s_client);
        s_started = false;
        s_connected = false;
    }
}

void cloud_mqtt_publish_status_now(void)
{
    if (!s_connected || s_client == NULL || s_runtime.get_wifi_status == NULL) {
        return;
    }

    wifi_manager_status_t wifi;
    memset(&wifi, 0, sizeof(wifi));
    s_runtime.get_wifi_status(&wifi, s_runtime.ctx);

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return;
    }
    cJSON_AddStringToObject(root, "device_id", s_config.device_id);
    cJSON_AddStringToObject(root, "fw", "wireless-debug");
    cJSON_AddNumberToObject(root, "uptime_ms", (double)(esp_timer_get_time() / 1000));
    cJSON_AddStringToObject(root, "net_mode", net_mode_json_name(wifi.mode));
    cJSON_AddBoolToObject(root, "sta_configured", wifi.sta_configured);
    cJSON_AddBoolToObject(root, "sta_connecting", wifi.sta_connecting);
    cJSON_AddBoolToObject(root, "sta_connected", wifi.sta_connected);
    cJSON_AddStringToObject(root, "ap_ip", wifi.ap_ip);
    cJSON_AddStringToObject(root, "sta_ip", wifi.sta_ip);
    cJSON_AddNumberToObject(root, "uart_baud",
                            s_runtime.get_uart_baud != NULL ? s_runtime.get_uart_baud(s_runtime.ctx) : 0);
    cJSON_AddStringToObject(root, "comm_mode",
                            s_runtime.get_comm_mode != NULL ?
                            comm_mode_json_name(s_runtime.get_comm_mode(s_runtime.ctx)) : "auto");
    cJSON_AddBoolToObject(root, "ble_ready",
                          s_runtime.ble_is_started != NULL && s_runtime.ble_is_started(s_runtime.ctx));
    cJSON_AddBoolToObject(root, "ble_subscribed",
                          s_runtime.ble_has_subscribers != NULL && s_runtime.ble_has_subscribers(s_runtime.ctx));
    cJSON_AddBoolToObject(root, "wifi_ws_client",
                          s_runtime.wifi_ws_client_connected != NULL &&
                          s_runtime.wifi_ws_client_connected(s_runtime.ctx));

    char *json = cJSON_PrintUnformatted(root);
    if (json != NULL) {
        esp_mqtt_client_publish(s_client, s_status_topic, json, 0, 1, 1);
        cJSON_free(json);
    }
    cJSON_Delete(root);
}
