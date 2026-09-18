#include "web_static.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <dirent.h>

#include "esp_log.h"
#include "esp_spiffs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "http_utils.h"

#ifndef MIN
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#endif

#define FILE_SEND_BUF_SIZE 1024
#define EXCEL_DIR      "/spiffs/excel"
#define EXCEL_MAX_SIZE (512 * 1024)

static const char *TAG = "web_static";

static const char *get_mime_type(const char *filename)
{
    if (strstr(filename, ".html")) return "text/html";
    if (strstr(filename, ".css"))  return "text/css";
    if (strstr(filename, ".js"))   return "application/javascript";
    if (strstr(filename, ".svg"))  return "image/svg+xml";
    if (strstr(filename, ".png"))  return "image/png";
    if (strstr(filename, ".ico"))  return "image/x-icon";
    return "text/plain";
}

void web_static_init(void)
{
    ESP_LOGI(TAG, "Initializing SPIFFS...");

    esp_vfs_spiffs_conf_t conf = {
        .base_path = "/spiffs",
        .partition_label = "storage",
        .max_files = 8,
        .format_if_mount_failed = true
    };

    esp_err_t ret = esp_vfs_spiffs_register(&conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "SPIFFS init failed: %s", esp_err_to_name(ret));
        return;
    }

    size_t total, used;
    esp_spiffs_info("storage", &total, &used);
    ESP_LOGI(TAG, "SPIFFS mounted: total=%dKB, used=%dKB", total / 1024, used / 1024);
}

static esp_err_t http_index_handler(httpd_req_t *req)
{
    char *path = (char *)malloc(516);
    char *buf = (char *)malloc(FILE_SEND_BUF_SIZE);
    if (path == NULL || buf == NULL) {
        free(path);
        free(buf);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "No memory");
        return ESP_ERR_NO_MEM;
    }

    const char *uri = req->uri;
    path[0] = '\0';
    strcpy(path, "/spiffs");

    if (strcmp(uri, "/") == 0) {
        strcat(path, "/index.html");
    } else {
        strncat(path, uri, 516 - strlen(path) - 4);
    }

    size_t base_len = strlen(path);
    strcat(path, ".gz");

    bool use_gzip = false;
    FILE *file = fopen(path, "rb");
    if (file != NULL) {
        use_gzip = true;
    } else {
        path[base_len] = '\0';
        file = fopen(path, "rb");
    }

    if (file == NULL) {
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "File not found");
        free(path);
        free(buf);
        return ESP_FAIL;
    }

    path[base_len] = '\0';
    httpd_resp_set_type(req, get_mime_type(path));

    if (use_gzip) {
        httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
        http_set_close(req);
    }

    size_t len;
    esp_err_t ret = ESP_OK;
    while ((len = fread(buf, 1, FILE_SEND_BUF_SIZE, file)) > 0) {
        if (httpd_resp_send_chunk(req, buf, len) != ESP_OK) {
            ESP_LOGE(TAG, "http send chunk failed: %s%s",
                     path, use_gzip ? ".gz" : "");
            ret = ESP_FAIL;
            break;
        }
        vTaskDelay(1);
    }

    if (ret == ESP_OK) {
        httpd_resp_send_chunk(req, NULL, 0);
    }
    fclose(file);
    free(path);
    free(buf);
    return ret;
}

static const httpd_uri_t http_index = {
    .uri       = "/*",
    .method    = HTTP_GET,
    .handler   = http_index_handler,
    .user_ctx  = NULL
};

static void excel_dir_ensure(void)
{
    DIR *d = opendir(EXCEL_DIR);
    if (d) {
        closedir(d);
        return;
    }
    mkdir(EXCEL_DIR, 0755);
    ESP_LOGI(TAG, "Created excel dir: %s", EXCEL_DIR);
}

static esp_err_t excel_list_handler(httpd_req_t *req)
{
    excel_dir_ensure();

    DIR *dir = opendir(EXCEL_DIR);
    if (!dir) {
        http_prepare_json(req);
        httpd_resp_sendstr(req, "[]");
        return ESP_OK;
    }

    http_prepare_json(req);

    struct dirent *entry;
    bool first = true;
    httpd_resp_sendstr_chunk(req, "[");
    while ((entry = readdir(dir)) != NULL) {
        if (entry->d_type != DT_REG) continue;
        char item[300];
        snprintf(item, sizeof(item), "%s\"%s\"", first ? "" : ",", entry->d_name);
        httpd_resp_sendstr_chunk(req, item);
        first = false;
    }
    closedir(dir);
    httpd_resp_sendstr_chunk(req, "]");
    httpd_resp_sendstr_chunk(req, NULL);
    return ESP_OK;
}

static const httpd_uri_t excel_list_uri = {
    .uri     = "/api/excel/list",
    .method  = HTTP_GET,
    .handler = excel_list_handler,
};

static esp_err_t excel_upload_handler(httpd_req_t *req)
{
    http_set_cors(req);
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "X-Filename, Content-Type");

    char filename[128] = {0};
    if (httpd_req_get_hdr_value_str(req, "X-Filename", filename, sizeof(filename)) != ESP_OK
        || strlen(filename) == 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing X-Filename header");
        return ESP_FAIL;
    }

    if (strstr(filename, "..") || strstr(filename, "/")) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid filename");
        return ESP_FAIL;
    }

    if (req->content_len > EXCEL_MAX_SIZE) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "File too large");
        return ESP_FAIL;
    }

    excel_dir_ensure();

    char path[256];
    snprintf(path, sizeof(path), "%s/%s", EXCEL_DIR, filename);

    FILE *f = fopen(path, "wb");
    if (!f) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Cannot create file");
        return ESP_FAIL;
    }

    char *buf = malloc(1024);
    if (!buf) {
        fclose(f);
        return ESP_ERR_NO_MEM;
    }

    int remaining = req->content_len;
    while (remaining > 0) {
        int recv_len = httpd_req_recv(req, buf, MIN(remaining, 1024));
        if (recv_len <= 0) {
            if (recv_len == HTTPD_SOCK_ERR_TIMEOUT) continue;
            free(buf);
            fclose(f);
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Receive error");
            return ESP_FAIL;
        }
        fwrite(buf, 1, recv_len, f);
        remaining -= recv_len;
    }
    free(buf);
    fclose(f);

    ESP_LOGI(TAG, "Excel uploaded: %s (%d bytes)", path, req->content_len);
    http_prepare_json(req);
    return http_send_json_ok(req);
}

static const httpd_uri_t excel_upload_uri = {
    .uri     = "/api/excel/upload",
    .method  = HTTP_POST,
    .handler = excel_upload_handler,
};

static esp_err_t excel_upload_options_handler(httpd_req_t *req)
{
    return http_send_options(req, "POST, OPTIONS", "X-Filename, Content-Type");
}

static const httpd_uri_t excel_upload_options_uri = {
    .uri     = "/api/excel/upload",
    .method  = HTTP_OPTIONS,
    .handler = excel_upload_options_handler,
};

static esp_err_t excel_delete_handler(httpd_req_t *req)
{
    http_set_cors(req);
    http_set_close(req);

    char query[256] = {0};
    char filename[128] = {0};

    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK
        || httpd_query_key_value(query, "name", filename, sizeof(filename)) != ESP_OK
        || strlen(filename) == 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing name param");
        return ESP_FAIL;
    }

    if (strstr(filename, "..") || strstr(filename, "/")) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid filename");
        return ESP_FAIL;
    }

    char path[256];
    snprintf(path, sizeof(path), "%s/%s", EXCEL_DIR, filename);

    if (remove(path) != 0) {
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "File not found");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Excel deleted: %s", path);
    http_prepare_json(req);
    return http_send_json_ok(req);
}

static const httpd_uri_t excel_delete_uri = {
    .uri     = "/api/excel/delete",
    .method  = HTTP_DELETE,
    .handler = excel_delete_handler,
};

static esp_err_t register_handler(httpd_handle_t server, const httpd_uri_t *uri, const char *name)
{
    esp_err_t ret = httpd_register_uri_handler(server, uri);
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "Failed to register %s: %s", name, esp_err_to_name(ret));
    }
    return ret;
}

esp_err_t web_static_register_handlers(httpd_handle_t server)
{
    esp_err_t first_error = ESP_OK;
    esp_err_t ret;

    ret = register_handler(server, &excel_list_uri, "excel list");
    if (first_error == ESP_OK) first_error = ret;
    ret = register_handler(server, &excel_upload_uri, "excel upload");
    if (first_error == ESP_OK) first_error = ret;
    ret = register_handler(server, &excel_upload_options_uri, "excel upload options");
    if (first_error == ESP_OK) first_error = ret;
    ret = register_handler(server, &excel_delete_uri, "excel delete");
    if (first_error == ESP_OK) first_error = ret;
    ret = register_handler(server, &http_index, "static index");
    if (first_error == ESP_OK) first_error = ret;

    return first_error;
}
