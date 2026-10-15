"""Host packet fixtures for the read-only USB DHCP observer."""

from pathlib import Path
import os
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "main"
HOST_FLAGS = ["-std=c11", "-Wall", "-Wextra", "-Werror"]
if os.environ.get("USB_DHCP_TRACE_SANITIZE") == "1":
    HOST_FLAGS += ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]

CHECKER = r'''
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include "local_usb_dhcp_trace.h"

#define CHECK(expr) do { if (!(expr)) { \
    fprintf(stderr, "line %d: %s\n", __LINE__, #expr); return 1; \
} } while (0)

static void be16(uint8_t *p, unsigned value) {
    p[0] = (uint8_t)(value >> 8); p[1] = (uint8_t)value;
}

static size_t packet(uint8_t *f, unsigned ihl, const uint8_t *opts,
                     size_t option_len, unsigned reply) {
    memset(f, 0, 600);
    f[12] = 8; f[13] = 0;
    uint8_t *ip = f + 14;
    ip[0] = (uint8_t)(0x40 | (ihl / 4)); ip[9] = 17;
    be16(ip + 2, ihl + 8 + 240 + option_len);
    uint8_t *udp = ip + ihl;
    be16(udp, reply ? 67 : 68); be16(udp + 2, reply ? 68 : 67);
    be16(udp + 4, 8 + 240 + option_len);
    uint8_t *dhcp = udp + 8;
    dhcp[0] = reply ? 2 : 1; dhcp[1] = 1; dhcp[2] = 6;
    dhcp[4] = 0x12; dhcp[5] = 0x34; dhcp[6] = 0x56; dhcp[7] = 0x78;
    const uint8_t mac[] = {0xae, 0xa7, 4, 0x31, 0x89, 0xf1};
    memcpy(dhcp + 28, mac, 6);
    dhcp[236] = 99; dhcp[237] = 130; dhcp[238] = 83; dhcp[239] = 99;
    memcpy(dhcp + 240, opts, option_len);
    return 14 + ihl + 8 + 240 + option_len;
}

static int valid_messages(void) {
    const char *types[] = {"DISCOVER", "OFFER", "REQUEST", "DECLINE",
                           "ACK", "NAK", "RELEASE", "INFORM"};
    uint8_t f[600], saved[600]; char out[256], expected[256];
    uint8_t opts[] = {0, 53, 1, 1, 50, 4, 192, 168, 4, 2,
                       54, 4, 192, 168, 4, 1, 255};
    for (unsigned type = 1; type <= 8; ++type) {
        opts[3] = (uint8_t)type;
        size_t n = packet(f, 20, opts, sizeof(opts), type == 2 || type == 5 || type == 6);
        memcpy(saved, f, sizeof(f));
        int size = snprintf(expected, sizeof(expected),
            "type=%s xid=12345678 mac=AE:A7:04:31:89:F1 ciaddr=0.0.0.0 "
            "yiaddr=0.0.0.0 requested=192.168.4.2 server=192.168.4.1", types[type - 1]);
        CHECK(local_usb_dhcp_trace_format(out, sizeof(out), f, n) == size);
        CHECK(strcmp(out, expected) == 0);
        CHECK(memcmp(f, saved, sizeof(f)) == 0);
    }
    uint8_t minimal[] = {53, 1, 3, 255, 53, 255}; /* END stops parsing. */
    size_t n = packet(f, 24, minimal, sizeof(minimal), 0);
    uint8_t *dhcp = f + 14 + 24 + 8;
    dhcp[12] = 10; dhcp[15] = 7; dhcp[16] = 192; dhcp[17] = 168;
    dhcp[18] = 4; dhcp[19] = 255;
    CHECK(local_usb_dhcp_trace_format(out, sizeof(out), f, n) > 0);
    CHECK(strstr(out, "ciaddr=10.0.0.7 yiaddr=192.168.4.255 requested=- server=-") != NULL);
    /* Ethernet padding and IP payload beyond UDP must not enter options. */
    f[n] = 53; f[n + 1] = 255;
    CHECK(local_usb_dhcp_trace_format(out, sizeof(out), f, n + 2) > 0);
    be16(f + 16, (unsigned)(n - 14 + 2));
    CHECK(local_usb_dhcp_trace_format(out, sizeof(out), f, n + 2) > 0);
    /* Unaligned frames are valid; the parser uses byte loads. */
    uint8_t unaligned[601]; memcpy(unaligned + 1, f, n + 2);
    CHECK(local_usb_dhcp_trace_format(out, sizeof(out), unaligned + 1, n + 2) > 0);
    return 0;
}

static int malformed_packets(void) {
    uint8_t f[600], original[600], saved[600]; char out[256];
    const uint8_t opts[] = {53, 1, 1, 255};
    size_t n = packet(original, 20, opts, sizeof(opts), 0);
    /* Every actual Ethernet/IP/UDP/BOOTP/options truncation. */
    for (size_t len = 0; len < n; ++len) {
        CHECK(local_usb_dhcp_trace_format(out, sizeof(out), original, len) == -1);
    }
    const struct { unsigned offset; uint8_t value; } corrupt[] = {
        {12, 0x86}, {14, 0x65}, {14, 0x44}, {14, 0x4f}, {23, 6},
        {20, 0x20}, {21, 1}, {34, 1}, {36, 1}, {42, 0}, {42, 3},
        {43, 2}, {44, 5}, {278, 0}, {284, 0}, {284, 9}
    };
    for (size_t i = 0; i < sizeof(corrupt) / sizeof(corrupt[0]); ++i) {
        memcpy(f, original, sizeof(f)); f[corrupt[i].offset] = corrupt[i].value;
        memcpy(saved, f, sizeof(f));
        CHECK(local_usb_dhcp_trace_format(out, sizeof(out), f, n) == -1);
        CHECK(memcmp(f, saved, sizeof(f)) == 0);
    }
    /* Declared IP/UDP lengths independently bound the decoder. */
    const unsigned lengths[] = {0, 19, 27, 267, 269, 65535};
    for (size_t i = 0; i < sizeof(lengths) / sizeof(lengths[0]); ++i) {
        memcpy(f, original, sizeof(f)); be16(f + 16, lengths[i]);
        CHECK(local_usb_dhcp_trace_format(out, sizeof(out), f, n) == -1);
    }
    const unsigned udp_lengths[] = {0, 7, 247, 249, 251, 253, 65535};
    for (size_t i = 0; i < sizeof(udp_lengths) / sizeof(udp_lengths[0]); ++i) {
        memcpy(f, original, sizeof(f)); be16(f + 38, udp_lengths[i]);
        CHECK(local_usb_dhcp_trace_format(out, sizeof(out), f, n) == -1);
    }
    memcpy(f, original, sizeof(f)); f[20] = 0x40; /* DF is not fragmentation. */
    CHECK(local_usb_dhcp_trace_format(out, sizeof(out), f, n) > 0);
    CHECK(local_usb_dhcp_trace_format(out, sizeof(out), NULL, n) == -1);
    CHECK(local_usb_dhcp_trace_format(NULL, sizeof(out), f, n) == -1);
    return 0;
}

static int malformed_options(void) {
    const uint8_t bad[][24] = {
        {255}, {53}, {53, 1}, {53, 0, 255}, {53, 2, 1, 1, 255},
        {53, 1, 1, 53, 1, 1, 255}, {53, 1, 1, 50, 3, 1, 2, 3, 255},
        {53, 1, 1, 54, 5, 1, 2, 3, 4, 5, 255},
        {53, 1, 1, 50, 4, 1, 2, 3, 4, 50, 4, 1, 2, 3, 4, 255},
        {53, 1, 1, 54, 4, 1, 2, 3, 4, 54, 4, 1, 2, 3, 4, 255},
        {53, 1, 1, 12, 255, 255}, {53, 1, 1}, {53, 1, 1, 50}
    };
    const size_t lengths[] = {1, 1, 2, 3, 5, 7, 9, 11, 16, 16, 6, 3, 4};
    uint8_t f[600]; char out[256];
    for (size_t i = 0; i < sizeof(lengths) / sizeof(lengths[0]); ++i) {
        size_t n = packet(f, 20, bad[i], lengths[i], 0);
        CHECK(local_usb_dhcp_trace_format(out, sizeof(out), f, n) == -1);
    }
    /* Unknown well-formed options are skipped without exposing their contents. */
    const uint8_t good[] = {0, 12, 3, 'p', 'c', '1', 60, 3, 'v', 'n', 'd', 53, 1, 1, 0, 255};
    size_t n = packet(f, 20, good, sizeof(good), 0);
    CHECK(local_usb_dhcp_trace_format(out, sizeof(out), f, n) > 0);
    CHECK(strstr(out, "pc1") == NULL && strstr(out, "vnd") == NULL);
    return 0;
}

static int output_bounds(void) {
    uint8_t f[600]; const uint8_t opts[] = {53, 1, 8, 255};
    size_t n = packet(f, 20, opts, sizeof(opts), 0);
    char out[256]; int required = local_usb_dhcp_trace_format(out, sizeof(out), f, n);
    CHECK(required > 0);
    for (size_t capacity = 0; capacity <= (size_t)required; ++capacity) {
        unsigned char guarded[258]; memset(guarded, 0xa5, sizeof(guarded));
        CHECK(local_usb_dhcp_trace_format((char *)guarded + 1, capacity, f, n) == -1);
        for (size_t i = 0; i < sizeof(guarded); ++i) CHECK(guarded[i] == 0xa5);
    }
    memset(out, 0x5a, sizeof(out));
    CHECK(local_usb_dhcp_trace_format(out, (size_t)required + 1, f, n) == required);
    CHECK(out[required] == '\0' && out[required + 1] == 0x5a);
    return 0;
}

static uint32_t random_state = 0x12345678;
static unsigned next_random(void) {
    random_state ^= random_state << 13;
    random_state ^= random_state >> 17;
    random_state ^= random_state << 5;
    return random_state;
}

static int arbitrary_frames(void) {
    uint8_t f[600], saved[600]; const uint8_t opts[] = {53, 1, 1, 255};
    for (unsigned round = 0; round < 4096; ++round) {
        size_t n = packet(f, (round & 1) ? 20 : 60, opts, sizeof(opts), round & 1);
        if (round & 2) {
            for (size_t i = 0; i < sizeof(f); ++i) f[i] = (uint8_t)next_random();
        } else {
            for (unsigned i = 0; i < 8; ++i) f[next_random() % n] = (uint8_t)next_random();
        }
        memcpy(saved, f, sizeof(f));
        size_t length = next_random() % (sizeof(f) + 1);
        unsigned char output[258]; memset(output, 0xa5, sizeof(output));
        size_t capacity = next_random() % 257;
        int result = local_usb_dhcp_trace_format((char *)output + 1, capacity, f, length);
        CHECK(memcmp(f, saved, sizeof(f)) == 0);
        CHECK(output[0] == 0xa5);
        for (size_t i = capacity + 1; i < sizeof(output); ++i) CHECK(output[i] == 0xa5);
        if (result < 0) {
            CHECK(result == -1);
            for (size_t i = 0; i < sizeof(output); ++i) CHECK(output[i] == 0xa5);
        } else {
            CHECK((size_t)result < capacity && output[result + 1] == 0);
        }
    }
    return 0;
}

#ifdef ESP_PLATFORM
int trace_level = 3;
int trace_calls;
char trace_line[320];
const char *trace_tag;
int esp_log_level_get(const char *tag) { trace_tag = tag; return trace_level; }
void fake_log(const char *tag, const char *format, ...) {
    trace_tag = tag; ++trace_calls;
    va_list args; va_start(args, format);
    vsnprintf(trace_line, sizeof(trace_line), format, args);
    va_end(args);
}
static int logging_wrapper(void) {
    trace_level = 2;
    /* An inaccessible frame catches parsing before the INFO early return. */
    local_usb_dhcp_trace_log("RX", (const void *)(uintptr_t)1, 600, 0);
    CHECK(trace_calls == 0);
    trace_level = 3;
    uint8_t f[600], saved[600]; const uint8_t opts[] = {53, 1, 4, 255};
    size_t n = packet(f, 20, opts, sizeof(opts), 0);
    memcpy(saved, f, sizeof(f));
    local_usb_dhcp_trace_log("RX", f, n, 0);
    CHECK(trace_calls == 1 && strcmp(trace_tag, "usb_dhcp_trace") == 0);
    CHECK(strstr(trace_line, "RX submit_result=0 type=DECLINE") != NULL);
    local_usb_dhcp_trace_log("TX", f, n, -17);
    CHECK(trace_calls == 2 && strstr(trace_line, "TX submit_result=-17") != NULL);
    CHECK(memcmp(f, saved, sizeof(f)) == 0);
    f[12] = 0x86;
    local_usb_dhcp_trace_log("RX", f, n, 0);
    CHECK(trace_calls == 2);
    return 0;
}
#endif

int main(void) {
    if (valid_messages() || malformed_packets() || malformed_options() || output_bounds() || arbitrary_frames()) return 1;
#ifdef ESP_PLATFORM
    if (logging_wrapper()) return 1;
#endif
    return 0;
}
'''


class UsbDhcpTraceRegression(unittest.TestCase):
    def test_formatter_decodes_real_packets_and_rejects_malformed_input(self):
        module = MAIN / "local_usb_dhcp_trace.c"
        self.assertTrue(module.is_file(), "missing USB DHCP trace implementation")
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "usb_dhcp_trace_check"
            compiled = subprocess.run(
                ["gcc", *HOST_FLAGS,
                 "-I", str(MAIN), "-x", "c", "-", "-x", "none",
                 str(module), "-o", str(executable)],
                input=CHECKER, text=True, capture_output=True, check=False,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            checked = subprocess.run([str(executable)], text=True, capture_output=True, check=False)
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_logging_wrapper_skips_disabled_and_non_dhcp_frames(self):
        module = MAIN / "local_usb_dhcp_trace.c"
        self.assertTrue(module.is_file(), "missing USB DHCP trace implementation")
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            (fixture / "esp_log.h").write_text(
                '#pragma once\n#define ESP_LOG_INFO 3\n'
                'int esp_log_level_get(const char *tag);\n'
                'void fake_log(const char *tag, const char *format, ...);\n'
                '#define ESP_LOGI(tag, ...) fake_log(tag, __VA_ARGS__)\n',
                encoding="utf-8",
            )
            executable = fixture / "usb_dhcp_logging_check"
            compiled = subprocess.run(
                ["gcc", *HOST_FLAGS, "-DESP_PLATFORM",
                 "-I", str(fixture), "-I", str(MAIN), "-x", "c", "-", "-x", "none",
                 str(module), "-o", str(executable)],
                input=CHECKER, text=True, capture_output=True, check=False,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            checked = subprocess.run([str(executable)], text=True, capture_output=True, check=False)
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_callbacks_observe_without_changing_existing_transport_contract(self):
        bridge = (MAIN / "local_access_bridge.c").read_text(encoding="utf-8")
        cmake = (MAIN / "CMakeLists.txt").read_text(encoding="utf-8")
        self.assertIn('#include "local_usb_dhcp_trace.h"', bridge)
        self.assertIn('"local_usb_dhcp_trace.c"', cmake)
        tx = bridge.split("static esp_err_t usb_transmit(", 1)[1].split(
            "static esp_err_t usb_receive(", 1)[0]
        self.assertIn("tud_mounted()", tx)
        self.assertIn("len > UINT16_MAX", tx)
        self.assertRegex(tx, r'esp_err_t ret = tinyusb_net_send_sync\(buffer, \(uint16_t\)len, NULL,\s*pdMS_TO_TICKS\(100\)\);\s*local_usb_dhcp_trace_log\("TX", buffer, len, ret\);\s*return ret;')
        rx = bridge.split("static esp_err_t usb_receive(", 1)[1].split(
            "static esp_err_t", 1)[0]
        self.assertIn('local_usb_dhcp_trace_log("RX", buffer, len, ESP_OK);', rx)
        self.assertLess(rx.index('local_usb_dhcp_trace_log("RX"'), rx.index("malloc(len)"))
        self.assertIn("local_usb_dhcp_policy_note_frame(buffer, len)", rx)
        self.assertIn("memcpy(copy, buffer, len)", rx)
        self.assertIn("return esp_netif_receive(s_usb_netif, copy, len, NULL)", rx)


if __name__ == "__main__":
    unittest.main()
