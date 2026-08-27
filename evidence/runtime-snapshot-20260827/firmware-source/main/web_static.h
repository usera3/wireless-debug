#ifndef WEB_STATIC_H
#define WEB_STATIC_H

#include "esp_err.h"
#include "esp_http_server.h"

void web_static_init(void);
esp_err_t web_static_register_handlers(httpd_handle_t server);

#endif /* WEB_STATIC_H */
