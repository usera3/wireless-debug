"""Real DHCP allocator and bounded USB recovery policy host regressions."""

from pathlib import Path
import importlib.util
import hashlib
import os
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "main"
SDK = Path(os.environ.get("USB_DHCP_TEST_IDF", "/mnt/c/esp/v6.0/esp-idf"))
SOURCE = SDK / "components/lwip/apps/dhcpserver/dhcpserver.c"
FLAGS = ["-std=c11", "-Wall", "-Wextra", "-Werror"]
if os.environ.get("USB_DHCP_RECOVERY_SANITIZE") == "1":
    FLAGS += ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]


def function(source, name):
    """Extract these C functions by balanced braces (not an allocator rewrite)."""
    match = re.search(r"^(?:static )?[^\n;]+\b" + name + r"\([^;]*?\)\s*\{", source, re.M)
    if not match:
        raise AssertionError(f"SDK function missing: {name}")
    start = source.index("{", match.start())
    depth = 1
    end = start + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[match.start():end]


ALLOCATOR_FIXTURE = r'''
#include <arpa/inet.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef uint8_t u8_t;
typedef uint16_t u16_t;
typedef int16_t s16_t;
typedef uint32_t u32_t;
struct dhcps_state { s16_t state; };
typedef struct { uint32_t addr; } ip4_addr_t;
typedef struct { bool enable; ip4_addr_t start_ip, end_ip; } dhcps_lease_t;
struct netif { int tag; };
struct dhcps_pool { ip4_addr_t ip; u8_t mac[6]; u32_t lease_timer; };
struct dhcps_msg {
    u8_t op, htype, hlen, hops, xid[4]; u16_t secs, flags;
    u8_t ciaddr[4], yiaddr[4], siaddr[4], giaddr[4], chaddr[16];
    u8_t sname[64], file[128], options[312];
};
typedef struct list_node { void *pnode; struct list_node *pnext; } list_node;
typedef struct {
    struct netif *dhcps_netif;
    ip4_addr_t client_address, client_address_plus;
    dhcps_lease_t dhcps_poll;
    uint32_t dhcps_lease_time;
    list_node *plist;
    bool renew, has_declined_ip;
} dhcps_t;
static const u32_t magic_cookie = 0x63538263;
#define DHCPS_LEASE_UNIT 60
#define DHCPS_COARSE_TIMER_SECS 1
#define DHCP_OPTION_MSG_TYPE 53
#define DHCP_OPTION_REQ_IPADDR 50
#define DHCP_OPTION_END 255
#define DHCPDISCOVER 1
#define DHCPREQUEST 3
#define DHCPDECLINE 4
#define DHCPRELEASE 7
#define DHCPS_STATE_OFFER 1
#define DHCPS_STATE_DECLINE 2
#define DHCPS_STATE_ACK 3
#define DHCPS_STATE_NAK 4
#define DHCPS_STATE_IDLE 5
#define DHCPS_STATE_RELEASE 6
#define mem_calloc calloc
#define mem_free free
#define ip4_addr_isany(p) ((p)->addr == 0)
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s\n", __LINE__, #x); return 1; } } while (0)
static bool drop_lease, block_two, block_all;
static bool before(struct netif *n, struct dhcps_msg *m, uint16_t len, uint32_t ip) {
    (void)n; (void)m; (void)len; (void)ip; return drop_lease;
}
static bool allowed(struct netif *n, uint32_t ip) {
    (void)n; return !block_all && !(block_two && ntohl(ip) == 0xc0a80402U);
}
#define LWIP_HOOK_DHCPS_RECOVERY_REQUEST(n,m,l,ip) before(n,m,l,ip)
#define LWIP_HOOK_DHCPS_RECOVERY_ADDRESS(n,ip) allowed(n,ip)
'''

ALLOCATOR_CHECK = r'''
static void message(struct dhcps_msg *m, uint8_t host, uint8_t type, uint8_t requested) {
    memset(m, 0, sizeof(*m)); m->op = 1; m->htype = 1; m->hlen = 6;
    m->chaddr[0] = 2; m->chaddr[5] = host;
    memcpy(m->options, &magic_cookie, 4);
    uint8_t opts[] = {53,1,type,50,4,192,168,4,requested,255};
    memcpy(m->options + 4, opts, sizeof(opts));
}
static void cleanup(dhcps_t *s) {
    while (s->plist) { list_node *n = s->plist; s->plist = n->pnext; free(n->pnode); free(n); }
}
int main(void) {
    dhcps_t s = {0}; struct dhcps_msg m;
    s.dhcps_poll.start_ip.addr = htonl(0xc0a80402U);
    s.dhcps_poll.end_ip.addr = htonl(0xc0a80405U);
    s.client_address_plus = s.dhcps_poll.start_ip;
    s.dhcps_lease_time = 120;
    message(&m, 1, 1, 2);
    CHECK(parse_msg(&s, &m, 10) == DHCPS_STATE_OFFER);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80402U);
    message(&m, 1, 3, 2);
    CHECK(parse_msg(&s, &m, 10) == DHCPS_STATE_ACK);
    /* Mirrors the observed new DISCOVER after an ACK: old lease must not stick. */
    drop_lease = block_two = true;
    message(&m, 1, 1, 2);
    CHECK(parse_msg(&s, &m, 10) == DHCPS_STATE_OFFER);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80403U);
    drop_lease = false;
    message(&m, 1, 3, 3);
    CHECK(parse_msg(&s, &m, 10) == DHCPS_STATE_ACK);
    message(&m, 1, 1, 3);
    CHECK(parse_msg(&s, &m, 10) == DHCPS_STATE_OFFER);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80403U);
    /* A different client cannot take this client's active lease. */
    message(&m, 2, 1, 2);
    CHECK(parse_msg(&s, &m, 10) == DHCPS_STATE_OFFER);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80404U);
    block_all = true;
    message(&m, 3, 1, 2);
    CHECK(parse_msg(&s, &m, 10) == DHCPS_STATE_IDLE);
    unsigned leases = 0; for (list_node *n = s.plist; n; n = n->pnext) ++leases;
    CHECK(leases == 2);
    cleanup(&s);
    /* Empty pool must not return to the quarantined start address. */
    memset(&s, 0, sizeof(s)); s.dhcps_lease_time = 120;
    s.dhcps_poll.start_ip.addr = htonl(0xc0a80402U);
    s.dhcps_poll.end_ip.addr = htonl(0xc0a80403U);
    s.client_address_plus = s.dhcps_poll.start_ip;
    block_all = false;
    message(&m, 1, 1, 2);
    CHECK(parse_msg(&s, &m, 10) == DHCPS_STATE_OFFER);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80403U);
    cleanup(&s); return 0;
}
'''

POLICY_CHECK = r'''
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "local_usb_dhcp_recovery.h"
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s\n", __LINE__, #x); return 1; } } while (0)
#define IP(n) (0xc0a80400U | (n))
static local_usb_dhcp_message_t msg(uint8_t type, uint32_t xid, unsigned ip) {
    local_usb_dhcp_message_t m = {0};
    m.type = type; m.xid = xid; m.mac[0] = 2; m.mac[5] = 1;
    m.requested = IP(ip); m.has_requested = true;
    if (type == 4) { m.server = IP(1); m.has_server = true; }
    return m;
}
static int retry_and_cap(void) {
    local_usb_dhcp_recovery_reset();
    local_usb_dhcp_message_t ack = msg(3, 10, 2), discover = msg(1, 11, 2);
    local_usb_dhcp_recovery_ack(&ack, IP(2), true, 1000);
    CHECK(local_usb_dhcp_recovery_before(&discover, IP(2), IP(1), false, 7000) == 0);
    discover.xid = 10;
    CHECK(local_usb_dhcp_recovery_before(&discover, IP(2), IP(1), true, 7000) == 0);
    discover.xid = 11;
    CHECK(local_usb_dhcp_recovery_before(&discover, IP(2), IP(1), true, 1999) == 0);
    CHECK(local_usb_dhcp_recovery_before(&discover, IP(2), IP(1), true, 7000) == LOCAL_USB_DHCP_RECOVERY_RETRY);
    CHECK(!local_usb_dhcp_recovery_allowed(IP(2), 7000));
    CHECK(local_usb_dhcp_recovery_allowed(IP(3), 7000));
    CHECK(local_usb_dhcp_recovery_before(&discover, IP(2), IP(1), true, 8000) == 0);
    for (unsigned i = 3; i <= 5; ++i) {
        ack = msg(3, i * 10, i); discover = msg(1, i * 10 + 1, i);
        local_usb_dhcp_recovery_ack(&ack, IP(i), true, i * 10000);
        CHECK(local_usb_dhcp_recovery_before(&discover, IP(i), IP(1), true, i * 10000 + 6000) == LOCAL_USB_DHCP_RECOVERY_RETRY);
    }
    ack = msg(3, 60, 6); discover = msg(1, 61, 6);
    local_usb_dhcp_recovery_ack(&ack, IP(6), true, 60000);
    CHECK(local_usb_dhcp_recovery_before(&discover, IP(6), IP(1), true, 66000) == 0);
    CHECK(local_usb_dhcp_recovery_allowed(IP(6), 66000));
    ack.mac[5] = discover.mac[5] = 2; ack.xid = 70; discover.xid = 71;
    local_usb_dhcp_recovery_ack(&ack, IP(6), true, 70000);
    CHECK(local_usb_dhcp_recovery_before(&discover, IP(6), IP(1), true, 76000) == 0);
    CHECK(local_usb_dhcp_recovery_allowed(IP(2), 307000));
    uint64_t long_uptime = (UINT64_C(1) << 32) + 7001;
    CHECK(local_usb_dhcp_recovery_allowed(IP(2), long_uptime));
    return 0;
}
static int protect_healthy_and_renewal(void) {
    local_usb_dhcp_recovery_reset();
    local_usb_dhcp_message_t ack = msg(3, 1, 2), d = msg(1, 2, 2);
    ack.ciaddr = IP(2);
    local_usb_dhcp_recovery_ack(&ack, IP(2), true, 1000);
    CHECK(local_usb_dhcp_recovery_before(&d, IP(2), IP(1), true, 7000) == 0);
    local_usb_dhcp_recovery_reset(); ack.ciaddr = 0;
    local_usb_dhcp_recovery_ack(&ack, IP(2), true, 1000);
    ack.overloaded = true; ack.ciaddr = IP(2); ack.xid = 3;
    local_usb_dhcp_recovery_ack(&ack, IP(2), true, 2000);
    CHECK(local_usb_dhcp_recovery_before(&d, IP(2), IP(1), true, 8000) == 0);
    ack.overloaded = false;
    local_usb_dhcp_recovery_reset(); ack.ciaddr = 0;
    local_usb_dhcp_recovery_ack(&ack, IP(2), true, 1000);
    uint8_t f[64] = {0}; memcpy(f + 6, ack.mac, 6); f[12] = 8;
    f[14] = 0x45; f[17] = 20; f[23] = 6;
    f[26] = 192; f[27] = 168; f[28] = 4; f[29] = 2;
    local_usb_dhcp_recovery_note_frame(f, 33); /* Truncated IP must not confirm. */
    f[29] = 3; local_usb_dhcp_recovery_note_frame(f, 34);
    f[29] = 2; f[11] = 2; local_usb_dhcp_recovery_note_frame(f, 34);
    f[11] = 1; local_usb_dhcp_recovery_note_frame(f, 34);
    CHECK(local_usb_dhcp_recovery_before(&d, IP(2), IP(1), true, 7000) == 0);
    /* A later renewal ACK must preserve a confirmed address. */
    ack.xid = 4; local_usb_dhcp_recovery_ack(&ack, IP(2), true, 8000);
    d.xid = 5;
    CHECK(local_usb_dhcp_recovery_before(&d, IP(2), IP(1), true, 14000) == 0);
    return 0;
}
static int timers_identity_declines(void) {
    local_usb_dhcp_recovery_reset();
    local_usb_dhcp_message_t ack = msg(3, 1, 2), d = msg(1, 2, 2);
    local_usb_dhcp_recovery_ack(&ack, IP(2), true, 1000);
    local_usb_dhcp_recovery_ack(&ack, IP(2), true, 59000); /* Duplicate must not prolong the window. */
    CHECK(local_usb_dhcp_recovery_before(&d, IP(2), IP(1), true, 61001) == 0);
    local_usb_dhcp_recovery_reset();
    local_usb_dhcp_recovery_ack(&ack, IP(2), true, UINT32_MAX - 2999);
    CHECK(local_usb_dhcp_recovery_before(&d, IP(2), IP(1), true, (uint64_t)UINT32_MAX + 3001) == LOCAL_USB_DHCP_RECOVERY_RETRY);
    local_usb_dhcp_recovery_reset();
    local_usb_dhcp_recovery_ack(&ack, IP(2), true, 1000);
    d.mac[5] = 2;
    CHECK(local_usb_dhcp_recovery_before(&d, IP(2), IP(1), true, 7000) == 0);
    d = msg(4, 3, 2); d.server = IP(9);
    CHECK(local_usb_dhcp_recovery_before(&d, IP(2), IP(1), true, 7000) == 0);
    d.server = IP(1);
    CHECK(local_usb_dhcp_recovery_before(&d, IP(3), IP(1), true, 7000) == 0);
    CHECK(local_usb_dhcp_recovery_before(&d, IP(2), IP(1), false, 7000) == 0);
    d.overloaded = true;
    CHECK(local_usb_dhcp_recovery_before(&d, IP(2), IP(1), true, 7000) == LOCAL_USB_DHCP_RECOVERY_DECLINE);
    local_usb_dhcp_recovery_reset_client();
    CHECK(!local_usb_dhcp_recovery_allowed(IP(2), 8000));
    for (unsigned i = 3; i <= 9; ++i) {
        d = msg(4, i, i);
        CHECK(local_usb_dhcp_recovery_before(&d, IP(i), IP(1), true, 8000) == LOCAL_USB_DHCP_RECOVERY_DECLINE);
    }
    d = msg(4, 10, 10);
    CHECK(local_usb_dhcp_recovery_before(&d, IP(10), IP(1), true, 8000) == 0);
    CHECK(local_usb_dhcp_recovery_allowed(IP(10), 8000));
    return 0;
}
static int parser(void) {
    uint8_t p[280] = {0}; p[0] = 1; p[1] = 1; p[2] = 6;
    p[4] = 0x12; p[5] = 0x34; p[6] = 0x56; p[7] = 0x78;
    p[28] = 2; p[33] = 1;
    uint8_t opts[] = {99,130,83,99,0,53,1,1,50,4,192,168,4,2,54,4,192,168,4,1,255};
    memcpy(p + 236, opts, sizeof(opts)); size_t n = 236 + sizeof(opts);
    local_usb_dhcp_message_t m, saved;
    memset(&m, 0xa5, sizeof(m)); saved = m;
    for (size_t i = 0; i < n; ++i) {
        CHECK(!local_usb_dhcp_recovery_parse(p, i, &m));
        CHECK(memcmp(&m, &saved, sizeof(m)) == 0);
    }
    CHECK(local_usb_dhcp_recovery_parse(p, n, &m));
    CHECK(m.xid == 0x12345678 && m.type == 1 && m.requested == IP(2) && m.server == IP(1));
    p[256] = 52; p[257] = 1; p[258] = 1; p[259] = 255;
    CHECK(local_usb_dhcp_recovery_parse(p, 260, &m)); /* Valid unsupported overload is not malformed. */
    p[256] = 255;
    p[243] = 9; CHECK(!local_usb_dhcp_recovery_parse(p, n, &m)); p[243] = 1;
    p[256] = 53; p[257] = 1; p[258] = 1; p[259] = 255;
    CHECK(!local_usb_dhcp_recovery_parse(p, 260, &m));
    CHECK(!local_usb_dhcp_recovery_parse(NULL, n, &m));
    CHECK(!local_usb_dhcp_recovery_parse(p, n, NULL));
    return 0;
}
int main(void) {
    return retry_and_cap() || protect_healthy_and_renewal() || timers_identity_declines() || parser();
}
'''

REPLAY_CALLBACKS = r'''
#include "local_usb_dhcp_recovery.h"
static uint32_t now_ms;
bool before(struct netif *n, struct dhcps_msg *m, uint16_t len, uint32_t ip) {
    (void)n; local_usb_dhcp_message_t parsed;
    if (!local_usb_dhcp_recovery_parse(m, len, &parsed)) return false;
    return local_usb_dhcp_recovery_before(&parsed, ntohl(ip), 0xc0a80401U,
                                          m->chaddr[5] == 1, now_ms) == LOCAL_USB_DHCP_RECOVERY_RETRY;
}
bool allowed(struct netif *n, uint32_t ip) {
    (void)n; return local_usb_dhcp_recovery_allowed(ntohl(ip), now_ms);
}
bool accept_recovery(struct netif *n, struct dhcps_msg *m, uint16_t len, uint32_t ip) {
    (void)n; local_usb_dhcp_message_t parsed;
    if (!local_usb_dhcp_recovery_parse(m, len, &parsed)) return true;
    return local_usb_dhcp_recovery_accept(&parsed, ntohl(ip), 0xc0a80401U,
                                          m->chaddr[5] == 1, now_ms);
}
#define LWIP_HOOK_DHCPS_RECOVERY_ACCEPT(n,m,l,ip) accept_recovery(n,m,l,ip)
#define LWIP_HOOK_DHCPS_RECOVERY_REQUEST(n,m,l,ip) before(n,m,l,ip)
#define LWIP_HOOK_DHCPS_RECOVERY_ADDRESS(n,ip) allowed(n,ip)
'''

REPLAY_CHECK = r'''
static int step(dhcps_t *s, struct dhcps_msg *m, uint16_t options_len) {
    int state = parse_msg(s, m, options_len);
    if (state == DHCPS_STATE_ACK) {
        local_usb_dhcp_message_t parsed;
        if (!local_usb_dhcp_recovery_parse(m, options_len + 240, &parsed)) return -1;
        local_usb_dhcp_recovery_ack(&parsed, ntohl(s->client_address.addr),
                                    m->chaddr[5] == 1, now_ms);
    }
    return state;
}
static void transaction(struct dhcps_msg *m, uint8_t host, uint8_t type,
                         uint8_t requested, uint8_t xid) {
    message(m, host, type, requested); m->xid[3] = xid;
}
int main(void) {
    local_usb_dhcp_recovery_reset();
    dhcps_t s = {0}; struct dhcps_msg m;
    s.dhcps_poll.start_ip.addr = htonl(0xc0a80402U);
    s.dhcps_poll.end_ip.addr = htonl(0xc0a80406U);
    s.client_address_plus = s.dhcps_poll.start_ip;
    s.dhcps_lease_time = 120;
    /* Existing Windows lease: REQUEST/ACK then a fresh DISCOVER 6 seconds later. */
    now_ms = 1000;
    transaction(&m, 1, 3, 2, 1);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_ACK);
    now_ms = 7000;
    transaction(&m, 1, 1, 2, 2);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_OFFER);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80403U);
    transaction(&m, 1, 3, 2, 1);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_IDLE); /* Protect the replacement OFFER before ACK. */
    transaction(&m, 1, 3, 3, 2);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_ACK);
    /* Late retransmissions for the quarantined old address cannot destroy .3. */
    transaction(&m, 1, 3, 2, 1);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_IDLE);
    m.options[13] = 52; m.options[14] = 1; m.options[15] = 1; m.options[16] = 255;
    CHECK(step(&s, &m, 13) == DHCPS_STATE_IDLE); /* Known main fields stay guarded with overload. */
    transaction(&m, 1, 4, 2, 1);
    const uint8_t old_server[] = {54,4,192,168,4,1,255};
    memcpy(m.options + 13, old_server, sizeof(old_server));
    CHECK(step(&s, &m, 16) == DHCPS_STATE_IDLE);
    transaction(&m, 1, 3, 3, 2);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_ACK);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80403U);
    /* Wi-Fi peer keeps its lease and does not overwrite USB ACK tracking. */
    transaction(&m, 2, 3, 4, 9);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_ACK);
    now_ms = 13000;
    transaction(&m, 1, 1, 3, 3);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_OFFER);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80405U);
    transaction(&m, 1, 3, 5, 3);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_ACK);
    /* Renew with ciaddr: no address hopping on the next DISCOVER. */
    m.ciaddr[0] = 192; m.ciaddr[1] = 168; m.ciaddr[2] = 4; m.ciaddr[3] = 5;
    m.xid[3] = 4;
    CHECK(step(&s, &m, 10) == DHCPS_STATE_ACK);
    now_ms = 19000;
    transaction(&m, 1, 1, 5, 5);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_OFFER);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80405U);
    /* Explicit DECLINE uses the original server release path. */
    transaction(&m, 1, 4, 5, 6);
    const uint8_t server[] = {54,4,192,168,4,1,255};
    memcpy(m.options + 13, server, sizeof(server));
    CHECK(step(&s, &m, 16) == DHCPS_STATE_DECLINE);
    CHECK(!local_usb_dhcp_recovery_allowed(0xc0a80405U, now_ms));
    transaction(&m, 1, 1, 5, 7);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_OFFER);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80406U);
    transaction(&m, 2, 3, 4, 10);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_ACK);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80404U);
    transaction(&m, 3, 1, 2, 11);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_IDLE); /* Pool is occupied or quarantined. */
    now_ms = 319001;
    CHECK(step(&s, &m, 10) == DHCPS_STATE_OFFER);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80402U); /* Expired quarantine is reusable. */
    transaction(&m, 2, 3, 4, 12);
    CHECK(step(&s, &m, 10) == DHCPS_STATE_ACK);
    CHECK(ntohl(s.client_address.addr) == 0xc0a80404U);
    cleanup(&s); return 0;
}
'''


class UsbDhcpRecoveryRegression(unittest.TestCase):
    def compile_run(self, code, modules=(), headers=None):
        with tempfile.TemporaryDirectory() as directory:
            for name, content in (headers or {}).items():
                path = Path(directory) / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            executable = Path(directory) / "check"
            compiled = subprocess.run(
                ["gcc", *FLAGS, "-I", directory, "-I", str(MAIN), "-x", "c", "-", "-x", "none",
                 *map(str, modules), "-o", str(executable)],
                input=code, text=True, capture_output=True,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            checked = subprocess.run([str(executable)], text=True, capture_output=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_production_hook_scoping_and_malformed_usb_decline_fail_closed(self):
        headers = {
            'esp_log.h': '#pragma once\n#define ESP_LOGI(tag, ...) ((void)(tag))\n#define ESP_LOGW(tag, ...) ((void)(tag))\n',
            'esp_timer.h': '#pragma once\n#include <stdint.h>\nint64_t esp_timer_get_time(void);\n',
            'lwip/ip4_addr.h': '#pragma once\n#include <stdint.h>\n#include <arpa/inet.h>\ntypedef struct {uint32_t addr;} ip4_addr_t;\n#define lwip_ntohl ntohl\n#define ip4_addr_isany_val(ip) ((ip).addr == 0)\n#define ip4_addr1(p) (ntohl((p)->addr)>>24)\n#define ip4_addr2(p) ((ntohl((p)->addr)>>16)&255)\n#define ip4_addr3(p) ((ntohl((p)->addr)>>8)&255)\n#define ip4_addr4(p) (ntohl((p)->addr)&255)\n',
            'lwip/netif.h': '#pragma once\n#include "ip4_addr.h"\nstruct netif {ip4_addr_t ip_addr;};\n#define netif_ip4_addr(n) (&(n)->ip_addr)\n',
            'dhcpserver/dhcpserver.h': '#pragma once\n#include <stdint.h>\nstruct dhcps_msg {uint8_t op,htype,hlen,hops,xid[4]; uint16_t secs,flags; uint8_t ciaddr[4],yiaddr[4],siaddr[4],giaddr[4],chaddr[16],sname[64],file[128],options[312];};\n',
        }
        checker = r'''
#include <arpa/inet.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "lwip/netif.h"
#include "dhcpserver/dhcpserver.h"
#include "lwip_hooks/local_usb_dhcp_hooks.h"
#include "local_usb_dhcp_policy.h"
#define CHECK(x) do { if (!(x)) {fprintf(stderr,"line %d: %s\n",__LINE__,#x);return 1;} } while(0)
static uint64_t clock_ms = 7000;
int64_t esp_timer_get_time(void) { return (int64_t)(clock_ms * 1000); }
int main(void) {
    struct netif bridge = {.ip_addr = {.addr = htonl(0xc0a80401U)}}, other = bridge;
    local_usb_dhcps_bind_netif(&bridge);
    uint8_t f[14] = {0}; f[6] = 2; f[11] = 1;
    local_usb_dhcp_policy_note_frame(f, sizeof(f));
    CHECK(local_usb_dhcp_policy_is_usb_client(f + 6));
    CHECK(!local_usb_dhcp_policy_is_usb_client(NULL));
    struct dhcps_msg m = {0}; m.op = 1; m.htype = 1; m.hlen = 6;
    memcpy(m.chaddr, f + 6, 6);
    uint8_t opts[] = {99,130,83,99,53,1,4,50,4,192,168,4,2,54,4,192,168,4,1,50,4,192,168,4,2,255};
    memcpy(m.options, opts, sizeof(opts));
    CHECK(!local_usb_dhcps_recovery_accept(&bridge,&m,236+sizeof(opts),htonl(0xc0a80403U)));
    CHECK(local_usb_dhcps_recovery_accept(&other,&m,236+sizeof(opts),htonl(0xc0a80403U)));
    m.chaddr[5] = 2; /* A Wi-Fi peer cannot be classified as this physical USB host. */
    CHECK(local_usb_dhcps_recovery_accept(&bridge,&m,236+sizeof(opts),htonl(0xc0a80403U)));
    /* handle_dhcp allocates max(sizeof(message), actual payload), not always 548. */
    _Alignas(struct dhcps_msg) uint8_t large[620] = {0};
    struct dhcps_msg *big = (void *)large;
    memcpy(big, &m, sizeof(m)); big->chaddr[5] = 1;
    const uint8_t valid[] = {99,130,83,99,53,1,3,50,4,192,168,4,3,54,4,192,168,4,1,255};
    memcpy(big->options, valid, sizeof(valid));
    CHECK(local_usb_dhcps_recovery_accept(&bridge,big,sizeof(large),htonl(0xc0a80403U)));
    local_usb_dhcps_recovery_ack(&bridge,big,sizeof(large),htonl(0xc0a80403U));
    big->xid[3] = 2; big->options[6] = 1; /* DISCOVER: no server identifier. */
    big->options[13] = 255;
    clock_ms = 13000;
    CHECK(local_usb_dhcps_recovery_request(&bridge,big,sizeof(large),htonl(0xc0a80403U)));
    CHECK(!local_usb_dhcps_recovery_address(&bridge,htonl(0xc0a80403U)));
    CHECK(local_usb_dhcps_recovery_address(&other,htonl(0xc0a80403U)));
    clock_ms = (UINT64_C(1) << 32) + 13001;
    CHECK(local_usb_dhcps_recovery_address(&bridge,htonl(0xc0a80403U)));
    return 0;
}
'''
        self.compile_run(checker, [MAIN / 'local_usb_dhcp_hooks.c', MAIN / 'local_usb_dhcp_policy.c',
                                  MAIN / 'local_usb_dhcp_recovery.c'], headers)

    def test_real_sdk_allocator_replaces_only_requested_lease_and_skips_blocked_ips(self):
        self.assertTrue(SOURCE.is_file(), f"set USB_DHCP_TEST_IDF to ESP-IDF 6.0: {SOURCE}")
        source = SOURCE.read_text(encoding="utf-8")
        generator = ROOT / "scripts/prepare_usb_dhcp_recovery.py"
        if generator.is_file():
            spec = importlib.util.spec_from_file_location("prepare_usb_dhcp_recovery", generator)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            source = module.transform(source)
        functions = "\n".join(function(source, name) for name in (
            "node_insert_to_list", "node_remove_from_list", "parse_options", "parse_msg",
        ))
        # Helpers are unused on the unmodified SDK; this is the expected red baseline.
        code = ALLOCATOR_FIXTURE.replace("static bool before", "bool before").replace(
            "static bool allowed", "bool allowed") + functions + ALLOCATOR_CHECK
        self.compile_run(code)

    def test_bounded_usb_policy_is_implemented(self):
        module = MAIN / "local_usb_dhcp_recovery.c"
        self.assertTrue(module.is_file(),
                        "missing bounded USB lease recovery policy")
        self.compile_run(POLICY_CHECK, [module])

    def test_observed_windows_sequence_with_real_policy_and_allocator_and_wifi_peer(self):
        generator = ROOT / 'scripts/prepare_usb_dhcp_recovery.py'
        spec = importlib.util.spec_from_file_location('replay_generator', generator)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        source = module.transform(SOURCE.read_text())
        functions = '\n'.join(function(source, name) for name in (
            'node_insert_to_list', 'node_remove_from_list', 'parse_options', 'parse_msg',
        ))
        prefix = ALLOCATOR_FIXTURE.split('static bool drop_lease,')[0]
        code = prefix + REPLAY_CALLBACKS + functions + function(ALLOCATOR_CHECK, 'message') + function(ALLOCATOR_CHECK, 'cleanup') + REPLAY_CHECK
        self.compile_run(code, [MAIN / 'local_usb_dhcp_recovery.c'])

    def test_build_replaces_only_the_local_compilation_unit_and_binds_bridge(self):
        integration = ROOT / "cmake/usb_dhcp_recovery.cmake"
        self.assertTrue(integration.is_file(), "missing reproducible DHCP build integration")
        cmake = integration.read_text(encoding="utf-8")
        self.assertIn('idf_component_get_property(lwip_lib lwip COMPONENT_LIB)', cmake)
        self.assertIn('set_property(TARGET ${lwip_lib} PROPERTY SOURCES', cmake)
        self.assertIn('CMAKE_CONFIGURE_DEPENDS', cmake)
        self.assertIn('FATAL_ERROR', cmake)
        self.assertIn('cmake/usb_dhcp_recovery.cmake', (ROOT / 'CMakeLists.txt').read_text())
        self.assertIn('"local_usb_dhcp_recovery.c"', (MAIN / 'CMakeLists.txt').read_text())
        bridge = (MAIN / 'local_access_bridge.c').read_text()
        self.assertIn('#include "esp_netif_net_stack.h"', bridge)
        self.assertIn('local_usb_dhcp_recovery_note_frame(buffer, len)', bridge)
        self.assertIn('local_usb_dhcp_recovery_reset_client()', bridge)
        self.assertLess(bridge.index('local_usb_dhcps_bind_netif('),
                        bridge.index('esp_netif_dhcps_start(s_bridge_netif)'))
        hooks = (MAIN / 'local_usb_dhcp_hooks.c').read_text()
        self.assertIn('netif != s_recovery_netif', hooks)
        self.assertIn('local_usb_dhcp_policy_is_usb_client', hooks)
        self.assertIn('local_usb_dhcp_recovery_before', hooks)
        self.assertIn('local_usb_dhcp_recovery_ack', hooks)
        self.assertIn('lwip_ntohl', hooks)

    def test_generator_pins_source_fails_on_drift_and_never_writes_shared_sdk(self):
        generator = ROOT / 'scripts/prepare_usb_dhcp_recovery.py'
        self.assertTrue(generator.is_file())
        spec = importlib.util.spec_from_file_location('recovery_generator', generator)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        source = SOURCE.read_text(encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'source mismatch'):
            module.transform(source + '\n')
        generated = module.transform(source)
        self.assertIn('LWIP_HOOK_DHCPS_RECOVERY_ACK', generated)
        digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'dhcpserver.c'
            result = subprocess.run(['python3', str(generator), str(SOURCE), str(target)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(target.read_text(), generated)
            result = subprocess.run(['python3', str(generator), str(SOURCE), str(SOURCE)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('must not replace', result.stderr)
        self.assertEqual(hashlib.sha256(SOURCE.read_bytes()).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main()
