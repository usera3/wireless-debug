#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "esp_netif.h"

/* Initialize the always-on local LAN shared by USB NCM and Wi-Fi SoftAP. */
esp_err_t local_access_bridge_init(void);

/* Wi-Fi manager configures this pre-created, address-less SoftAP port. */
esp_netif_t *local_access_bridge_ap_netif(void);

bool local_access_bridge_usb_attached(void);
