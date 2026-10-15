#include "local_usb_dhcp_recovery.h"

#include <string.h>

#ifdef ESP_PLATFORM
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
static portMUX_TYPE s_recovery_lock = portMUX_INITIALIZER_UNLOCKED;
#define RECOVERY_LOCK() portENTER_CRITICAL(&s_recovery_lock)
#define RECOVERY_UNLOCK() portEXIT_CRITICAL(&s_recovery_lock)
#else
#define RECOVERY_LOCK() ((void)0)
#define RECOVERY_UNLOCK() ((void)0)
#endif

enum {
    QUARANTINE_SLOTS = 8,
    QUARANTINE_MS = 300000,
    RETRY_MIN_MS = 1000,
    RETRY_MAX_MS = 60000,
    RETRY_LIMIT = 4,
    DHCP_FIXED_SIZE = 240,
};

typedef struct {
    uint32_t ip;
    uint64_t since_ms;
    bool valid;
} quarantine_t;

/* One native USB cable has one host; this is not the shared DHCP lease table. */
static struct {
    uint8_t mac[6];
    uint32_t ip;
    uint32_t xid;
    uint64_t ack_ms;
    bool pending;
    bool confirmed;
} s_client;
static quarantine_t s_quarantine[QUARANTINE_SLOTS];
/* Connection budget survives host MAC changes; USB reset/detach clears it. */
static unsigned s_retries;

static uint16_t read_be16(const uint8_t *p)
{
    return (uint16_t)(((uint16_t)p[0] << 8) | p[1]);
}

static uint32_t read_be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | p[3];
}

void local_usb_dhcp_recovery_reset(void)
{
    RECOVERY_LOCK();
    memset(&s_client, 0, sizeof(s_client));
    memset(s_quarantine, 0, sizeof(s_quarantine));
    s_retries = 0;
    RECOVERY_UNLOCK();
}

void local_usb_dhcp_recovery_reset_client(void)
{
    RECOVERY_LOCK();
    memset(&s_client, 0, sizeof(s_client));
    s_retries = 0;
    RECOVERY_UNLOCK();
}

bool local_usb_dhcp_recovery_parse(const void *payload, size_t length,
                                  local_usb_dhcp_message_t *message)
{
    if (payload == NULL || message == NULL || length < DHCP_FIXED_SIZE) {
        return false;
    }
    const uint8_t *p = payload;
    if (p[0] != 1 || p[1] != 1 || p[2] != 6 || p[3] != 0 ||
        (p[28] & 1U) != 0 || read_be32(p + 24) != 0 ||
        read_be32(p + 236) != 0x63825363U) {
        return false;
    }
    local_usb_dhcp_message_t parsed = {0};
    memcpy(parsed.mac, p + 28, sizeof(parsed.mac));
    parsed.xid = read_be32(p + 4);
    parsed.ciaddr = read_be32(p + 12);
    bool ended = false;
    size_t offset = DHCP_FIXED_SIZE;
    while (offset < length) {
        unsigned code = p[offset++];
        if (code == 0) {
            continue;
        }
        if (code == 255) {
            ended = true;
            break;
        }
        if (offset == length) {
            return false;
        }
        size_t option_length = p[offset++];
        if (option_length > length - offset) {
            return false;
        }
        if (code == 53) {
            if (parsed.type != 0 || option_length != 1 ||
                p[offset] < 1 || p[offset] > 8) {
                return false;
            }
            parsed.type = p[offset];
        } else if (code == 50) {
            if (parsed.has_requested || option_length != 4) {
                return false;
            }
            parsed.has_requested = true;
            parsed.requested = read_be32(p + offset);
        } else if (code == 54) {
            if (parsed.has_server || option_length != 4) {
                return false;
            }
            parsed.has_server = true;
            parsed.server = read_be32(p + offset);
        } else if (code == 52) {
            if (parsed.overloaded || option_length != 1 ||
                p[offset] < 1 || p[offset] > 3) {
                return false;
            }
            /* Valid but unsupported: retain ordinary upstream behavior. */
            parsed.overloaded = true;
        }
        offset += option_length;
    }
    if (!ended || (parsed.type == 0 && !parsed.overloaded)) {
        return false;
    }
    *message = parsed;
    return true;
}

/* Caller owns the short state lock. Never evict an unexpired entry. */
static bool quarantine_ip(uint32_t ip, uint64_t now_ms)
{
    quarantine_t *free_slot = NULL;
    for (unsigned i = 0; i < QUARANTINE_SLOTS; ++i) {
        quarantine_t *q = &s_quarantine[i];
        if (q->valid && now_ms - q->since_ms < QUARANTINE_MS) {
            if (q->ip == ip) {
                return true; /* Replayed DECLINE does not prolong quarantine. */
            }
        } else if (free_slot == NULL) {
            free_slot = q;
        }
    }
    if (free_slot == NULL) {
        return false;
    }
    *free_slot = (quarantine_t){.ip = ip, .since_ms = now_ms, .valid = true};
    return true;
}

static bool is_quarantined(uint32_t ip, uint64_t now_ms)
{
    for (unsigned i = 0; i < QUARANTINE_SLOTS; ++i) {
        const quarantine_t *q = &s_quarantine[i];
        if (q->valid && q->ip == ip &&
            now_ms - q->since_ms < QUARANTINE_MS) {
            return true;
        }
    }
    return false;
}

bool local_usb_dhcp_recovery_accept(const local_usb_dhcp_message_t *message,
                                   uint32_t lease_ip, uint32_t server_ip,
                                   bool is_usb, uint64_t now_ms)
{
    if (message == NULL || !is_usb || lease_ip == 0) {
        return true;
    }
    if (message->type == 4) {
        /* The stock server does not check these before deleting a MAC's lease. */
        return message->ciaddr == 0 && message->has_requested &&
               message->requested == lease_ip && message->has_server &&
               message->server == server_ip;
    }
    bool accept = true;
    RECOVERY_LOCK();
    if (message->type == 3 && message->ciaddr == 0 &&
        message->has_requested && message->requested != lease_ip &&
        is_quarantined(message->requested, now_ms)) {
        /* A delayed request for our rejected candidate must not delete its replacement. */
        accept = false;
    }
    RECOVERY_UNLOCK();
    return accept;
}

int local_usb_dhcp_recovery_before(const local_usb_dhcp_message_t *message,
                                   uint32_t lease_ip, uint32_t server_ip,
                                   bool is_usb, uint64_t now_ms)
{
    if (message == NULL || !is_usb ||
        lease_ip == 0 || lease_ip == server_ip) {
        return LOCAL_USB_DHCP_RECOVERY_NONE;
    }
    int reason = LOCAL_USB_DHCP_RECOVERY_NONE;
    RECOVERY_LOCK();
    if (message->type == 4 && message->ciaddr == 0 &&
        message->has_requested && message->requested == lease_ip &&
        message->has_server && message->server == server_ip) {
        if (quarantine_ip(lease_ip, now_ms)) {
            reason = LOCAL_USB_DHCP_RECOVERY_DECLINE;
            s_client.pending = false;
        }
    } else {
        uint64_t age_ms = now_ms - s_client.ack_ms;
        if (!message->overloaded && message->type == 1 && message->ciaddr == 0 &&
            message->has_requested && message->requested == lease_ip &&
            !message->has_server && s_client.pending && !s_client.confirmed &&
            s_client.ip == lease_ip &&
            memcmp(s_client.mac, message->mac, sizeof(s_client.mac)) == 0 &&
            s_client.xid != message->xid && age_ms >= RETRY_MIN_MS &&
            age_ms <= RETRY_MAX_MS && s_retries < RETRY_LIMIT &&
            quarantine_ip(lease_ip, now_ms)) {
            ++s_retries;
            s_client.pending = false;
            reason = LOCAL_USB_DHCP_RECOVERY_RETRY;
        }
    }
    RECOVERY_UNLOCK();
    return reason;
}

void local_usb_dhcp_recovery_ack(const local_usb_dhcp_message_t *message,
                                uint32_t assigned_ip, bool is_usb,
                                uint64_t now_ms)
{
    if (message == NULL || !is_usb || message->type != 3 || assigned_ip == 0 ||
        (message->overloaded && message->ciaddr != assigned_ip)) {
        return;
    }
    RECOVERY_LOCK();
    if (memcmp(s_client.mac, message->mac, sizeof(s_client.mac)) != 0) {
        memset(&s_client, 0, sizeof(s_client));
        memcpy(s_client.mac, message->mac, sizeof(s_client.mac));
    }
    bool same_address = s_client.pending && s_client.ip == assigned_ip;
    bool duplicate = same_address && s_client.xid == message->xid;
    bool confirmed = (same_address && s_client.confirmed) ||
                     message->ciaddr == assigned_ip;
    if (!duplicate) {
        s_client.ack_ms = now_ms;
    }
    s_client.ip = assigned_ip;
    s_client.xid = message->xid;
    s_client.pending = true;
    s_client.confirmed = confirmed;
    RECOVERY_UNLOCK();
}

bool local_usb_dhcp_recovery_allowed(uint32_t ip, uint64_t now_ms)
{
    RECOVERY_LOCK();
    bool allowed = !is_quarantined(ip, now_ms);
    RECOVERY_UNLOCK();
    return allowed;
}

void local_usb_dhcp_recovery_note_frame(const void *frame, size_t length)
{
    if (frame == NULL || length < 34) {
        return;
    }
    const uint8_t *ethernet = frame;
    const uint8_t *ip = ethernet + 14;
    size_t ihl = (size_t)(ip[0] & 15U) * 4;
    size_t total = read_be16(ip + 2);
    if (read_be16(ethernet + 12) != 0x0800 || (ip[0] >> 4) != 4 ||
        ihl < 20 || total < ihl || total > length - 14 ||
        (read_be16(ip + 6) & 0x3fffU) != 0) {
        return;
    }
    if (ip[9] == 17) {
        if (total < ihl + 8 || read_be16(ip + ihl + 4) < 8 ||
            read_be16(ip + ihl + 4) > total - ihl) {
            return;
        }
        if (read_be16(ip + ihl) == 68 && read_be16(ip + ihl + 2) == 67) {
            return; /* DHCP traffic itself is not proof of address installation. */
        }
    }
    uint32_t source_ip = read_be32(ip + 12);
    RECOVERY_LOCK();
    if (s_client.pending && s_client.ip == source_ip &&
        memcmp(s_client.mac, ethernet + 6, sizeof(s_client.mac)) == 0) {
        s_client.confirmed = true;
    }
    RECOVERY_UNLOCK();
}
