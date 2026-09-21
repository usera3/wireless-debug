/* Microsoft OS 2.0 descriptors make Windows bind its inbox WINNCM driver. */
#include <stddef.h>

#include "usb_ncm_windows.h"

#define LE16(value) (uint8_t)(value), (uint8_t)((value) >> 8)
#define LE32(value) LE16(value), LE16((value) >> 16)
#define UTF16(ch) (ch), 0x00

const uint8_t usb_ncm_bos_descriptor[33] = {
    5, 0x0f, LE16(33), 1,
    28, 0x10, 0x05, 0x00,
    0xdf, 0x60, 0xdd, 0xd8, 0x89, 0x45, 0xc7, 0x4c,
    0x9c, 0xd2, 0x65, 0x9d, 0x9e, 0x64, 0x8a, 0x9f,
    LE32(0x06030000), LE16(USB_NCM_MS_OS_20_LENGTH),
    USB_NCM_MS_VENDOR_CODE, 0x00,
};

const uint8_t usb_ncm_ms_os_20_descriptor[USB_NCM_MS_OS_20_LENGTH] = {
    LE16(10), LE16(0), LE32(0x06030000), LE16(USB_NCM_MS_OS_20_LENGTH),
    LE16(8), LE16(1), 0x00, 0x00, LE16(USB_NCM_MS_OS_20_LENGTH - 10),
    LE16(8), LE16(2), 0x00, 0x00, LE16(USB_NCM_MS_OS_20_LENGTH - 18),
    LE16(20), LE16(3), 'W', 'I', 'N', 'N', 'C', 'M', 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,

    LE16(132), LE16(4), LE16(7), LE16(42),
    UTF16('D'), UTF16('e'), UTF16('v'), UTF16('i'), UTF16('c'), UTF16('e'),
    UTF16('I'), UTF16('n'), UTF16('t'), UTF16('e'), UTF16('r'), UTF16('f'),
    UTF16('a'), UTF16('c'), UTF16('e'), UTF16('G'), UTF16('U'), UTF16('I'),
    UTF16('D'), UTF16('s'), UTF16(0),
    LE16(80),
    UTF16('{'), UTF16('4'), UTF16('2'), UTF16('C'), UTF16('2'), UTF16('3'),
    UTF16('6'), UTF16('1'), UTF16('9'), UTF16('-'), UTF16('9'), UTF16('A'),
    UTF16('E'), UTF16('5'), UTF16('-'), UTF16('4'), UTF16('E'), UTF16('1'),
    UTF16('0'), UTF16('-'), UTF16('B'), UTF16('5'), UTF16('F'), UTF16('2'),
    UTF16('-'), UTF16('7'), UTF16('3'), UTF16('4'), UTF16('0'), UTF16('D'),
    UTF16('2'), UTF16('1'), UTF16('8'), UTF16('1'), UTF16('3'), UTF16('1'),
    UTF16('6'), UTF16('}'), UTF16(0), UTF16(0),
};

bool usb_ncm_windows_get_descriptor(uint8_t request_type, uint8_t request,
                                    uint16_t index, const uint8_t **data,
                                    uint16_t *length)
{
    if (request_type != 0xc0 || request != USB_NCM_MS_VENDOR_CODE ||
        index != 7 || data == NULL || length == NULL) {
        return false;
    }
    *data = usb_ncm_ms_os_20_descriptor;
    *length = sizeof(usb_ncm_ms_os_20_descriptor);
    return true;
}
