#pragma once

#include <stdbool.h>
#include <stdint.h>

#define USB_NCM_MS_VENDOR_CODE 1
#define USB_NCM_MS_OS_20_LENGTH 0xB2

extern const uint8_t usb_ncm_bos_descriptor[33];
extern const uint8_t usb_ncm_ms_os_20_descriptor[USB_NCM_MS_OS_20_LENGTH];

bool usb_ncm_windows_get_descriptor(uint8_t request_type, uint8_t request,
                                    uint16_t index, const uint8_t **data,
                                    uint16_t *length);
