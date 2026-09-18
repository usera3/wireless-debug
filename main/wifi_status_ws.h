#ifndef WIFI_STATUS_WS_H
#define WIFI_STATUS_WS_H

#include <stdbool.h>

#include "esp_err.h"
#include "esp_http_server.h"
#include "wifi_manager.h"

esp_err_t wifi_status_ws_register(httpd_handle_t server);
void wifi_status_ws_publish(const wifi_manager_status_t *status);
bool wifi_status_ws_client_connected(void);

#endif /* WIFI_STATUS_WS_H */
