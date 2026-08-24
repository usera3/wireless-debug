#ifndef HTTP_UTILS_H
#define HTTP_UTILS_H

#include <stdbool.h>

#include "esp_err.h"
#include "esp_http_server.h"

void http_set_cors(httpd_req_t *req);
void http_set_close(httpd_req_t *req);
void http_prepare_json(httpd_req_t *req);
esp_err_t http_send_json_ok(httpd_req_t *req);
esp_err_t http_send_options(httpd_req_t *req, const char *methods, const char *headers);

#endif /* HTTP_UTILS_H */
