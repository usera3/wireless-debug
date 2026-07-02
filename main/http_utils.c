#include "http_utils.h"

#include <stdbool.h>
#include <stdio.h>

void http_set_cors(httpd_req_t *req)
{
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
}

void http_set_close(httpd_req_t *req)
{
    httpd_resp_set_hdr(req, "Connection", "close");
}

void http_prepare_json(httpd_req_t *req)
{
    httpd_resp_set_type(req, "application/json");
    http_set_cors(req);
    http_set_close(req);
}

esp_err_t http_send_json_ok(httpd_req_t *req)
{
    return httpd_resp_sendstr(req, "{\"ok\":true}");
}

esp_err_t http_send_options(httpd_req_t *req, const char *methods, const char *headers)
{
    http_set_cors(req);
    if (methods != NULL) {
        httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", methods);
    }
    if (headers != NULL) {
        httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", headers);
    }
    http_set_close(req);
    return httpd_resp_sendstr(req, "");
}
