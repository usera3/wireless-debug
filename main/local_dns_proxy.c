#include "local_dns_proxy.h"

#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "esp_log.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"

#define LOCAL_DNS_PORT 53
#define DNS_HEADER_SIZE 12
#define DNS_PACKET_CAPACITY 1500
#define DNS_UPSTREAM_TIMEOUT_MS 1200

static const char *TAG = "local_dns";
static bool s_started;

static bool current_upstream_dns(struct sockaddr_in *address)
{
    esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (sta == NULL || !esp_netif_is_netif_up(sta)) {
        return false;
    }

    esp_netif_ip_info_t sta_ip = {0};
    if (esp_netif_get_ip_info(sta, &sta_ip) != ESP_OK || sta_ip.ip.addr == 0) {
        return false;
    }

    esp_netif_dns_info_t dns = {0};
    if (esp_netif_get_dns_info(sta, ESP_NETIF_DNS_MAIN, &dns) != ESP_OK ||
        dns.ip.type != ESP_IPADDR_TYPE_V4 || dns.ip.u_addr.ip4.addr == 0 ||
        dns.ip.u_addr.ip4.addr == ESP_IP4TOADDR(192, 168, 4, 1)) {
        return false;
    }

    memset(address, 0, sizeof(*address));
    address->sin_family = AF_INET;
    address->sin_port = htons(LOCAL_DNS_PORT);
    address->sin_addr.s_addr = dns.ip.u_addr.ip4.addr;
    return true;
}

static size_t make_servfail(const uint8_t *request, size_t request_len,
                            uint8_t *response)
{
    memcpy(response, request, request_len);
    /* QR=response, preserve opcode and RD; RA=available, RCODE=SERVFAIL. */
    response[2] = (uint8_t)(0x80U | (request[2] & 0x79U));
    response[3] = 0x82U;
    response[6] = 0;
    response[7] = 0;
    response[8] = 0;
    response[9] = 0;
    return request_len;
}

static bool forward_query(const uint8_t *request, size_t request_len,
                          uint8_t *response, ssize_t *response_len)
{
    struct sockaddr_in upstream;
    if (!current_upstream_dns(&upstream)) {
        return false;
    }

    int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (fd < 0) {
        return false;
    }
    struct timeval timeout = {
        .tv_sec = DNS_UPSTREAM_TIMEOUT_MS / 1000,
        .tv_usec = (DNS_UPSTREAM_TIMEOUT_MS % 1000) * 1000,
    };
    (void)setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

    bool ok = sendto(fd, request, request_len, 0,
                     (struct sockaddr *)&upstream, sizeof(upstream)) ==
              (ssize_t)request_len;
    if (ok) {
        struct sockaddr_in sender;
        socklen_t sender_len = sizeof(sender);
        *response_len = recvfrom(fd, response, DNS_PACKET_CAPACITY, 0,
                                 (struct sockaddr *)&sender, &sender_len);
        ok = *response_len >= DNS_HEADER_SIZE &&
             sender.sin_addr.s_addr == upstream.sin_addr.s_addr &&
             response[0] == request[0] && response[1] == request[1];
    }
    close(fd);
    return ok;
}

static void dns_proxy_task(void *arg)
{
    int local_fd = (int)(intptr_t)arg;
    uint8_t request[DNS_PACKET_CAPACITY];
    uint8_t response[DNS_PACKET_CAPACITY];

    while (true) {
        struct sockaddr_in client;
        socklen_t client_len = sizeof(client);
        ssize_t request_len = recvfrom(local_fd, request, sizeof(request), 0,
                                       (struct sockaddr *)&client, &client_len);
        if (request_len < DNS_HEADER_SIZE || (request[2] & 0x80U) != 0) {
            continue;
        }

        ssize_t response_len = 0;
        if (!forward_query(request, (size_t)request_len,
                           response, &response_len)) {
            response_len = (ssize_t)make_servfail(
                request, (size_t)request_len, response);
        }
        (void)sendto(local_fd, response, (size_t)response_len, 0,
                     (struct sockaddr *)&client, client_len);
    }
}

esp_err_t local_dns_proxy_start(void)
{
    if (s_started) {
        return ESP_OK;
    }

    int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (fd < 0) {
        ESP_LOGE(TAG, "socket failed: errno=%d", errno);
        return ESP_FAIL;
    }
    struct sockaddr_in local = {
        .sin_family = AF_INET,
        .sin_port = htons(LOCAL_DNS_PORT),
        .sin_addr.s_addr = ESP_IP4TOADDR(192, 168, 4, 1),
    };
    if (bind(fd, (struct sockaddr *)&local, sizeof(local)) != 0) {
        ESP_LOGE(TAG, "bind 192.168.4.1:53 failed: errno=%d", errno);
        close(fd);
        return ESP_FAIL;
    }

    BaseType_t created = xTaskCreate(dns_proxy_task, "local_dns", 6144,
                                     (void *)(intptr_t)fd, 4, NULL);
    if (created != pdPASS) {
        close(fd);
        return ESP_ERR_NO_MEM;
    }
    s_started = true;
    ESP_LOGI(TAG, "DNS proxy listening on 192.168.4.1:53");
    return ESP_OK;
}
