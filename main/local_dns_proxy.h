#pragma once

#include "esp_err.h"

/*
 * ESP-IDF's DHCP server always advertises its own address as DNS when no
 * explicit DNS server is configured. Keep that promise useful: forward DNS
 * through the cloud STA when available, otherwise answer SERVFAIL immediately
 * so the host can try another network interface without waiting.
 */
esp_err_t local_dns_proxy_start(void);
