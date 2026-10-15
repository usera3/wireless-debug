"""Generate a pinned project-local ESP-IDF DHCP compilation unit.

The shared SDK is read-only. Only the specified build output is written.
"""

from pathlib import Path
import argparse
import hashlib

SOURCE_SHA256 = "b202508a105f4f4536fd75027ccbc797c44b8e46a7a396ea23c5ee205ed3d67a"

BEFORE_REUSE = r'''
#ifdef LWIP_HOOK_DHCPS_RECOVERY_REQUEST
        /* Allow project recovery to drop only this client's stale candidate. */
        for (list_node *node = dhcps->plist; node != NULL; node = node->pnext) {
            struct dhcps_pool *pool = node->pnode;
            if (memcmp(pool->mac, m->chaddr, sizeof(pool->mac)) == 0) {
#ifdef LWIP_HOOK_DHCPS_RECOVERY_ACCEPT
                if (!LWIP_HOOK_DHCPS_RECOVERY_ACCEPT(dhcps->dhcps_netif, m,
                                                    len + 240, pool->ip.addr)) {
                    return DHCPS_STATE_IDLE;
                }
#endif
                if (LWIP_HOOK_DHCPS_RECOVERY_REQUEST(dhcps->dhcps_netif, m,
                                                    len + 240, pool->ip.addr)) {
                    node_remove_from_list(&dhcps->plist, node);
                    mem_free(pool);
                    mem_free(node);
                }
                break;
            }
        }
#endif
'''

FILTER_CANDIDATE = r'''
#ifdef LWIP_HOOK_DHCPS_RECOVERY_ADDRESS
        if (!LWIP_HOOK_DHCPS_RECOVERY_ADDRESS(dhcps->dhcps_netif,
                                             dhcps->client_address.addr)) {
            /* Keep normal leases and search only inside the configured pool. */
            bool found = false;
            u32_t start = ntohl(dhcps->dhcps_poll.start_ip.addr);
            u32_t end = ntohl(dhcps->dhcps_poll.end_ip.addr);
            for (u32_t candidate = start; candidate <= end; ++candidate) {
                u32_t wire_ip = htonl(candidate);
                bool occupied = false;
                for (list_node *node = dhcps->plist; node != NULL; node = node->pnext) {
                    struct dhcps_pool *pool = node->pnode;
                    if (pool->ip.addr == wire_ip) {
                        occupied = true;
                        break;
                    }
                }
                if (!occupied && LWIP_HOOK_DHCPS_RECOVERY_ADDRESS(dhcps->dhcps_netif, wire_ip)) {
                    dhcps->client_address.addr = wire_ip;
                    found = true;
                    break;
                }
                if (candidate == end) {
                    break; /* Avoid uint32 wrap even on an invalid huge range. */
                }
            }
            if (!found) {
                memset(&dhcps->client_address, 0, sizeof(dhcps->client_address));
                return DHCPS_STATE_IDLE;
            }
        }
#endif
'''

ACK_OBSERVER = r'''
#ifdef LWIP_HOOK_DHCPS_RECOVERY_ACK
            LWIP_HOOK_DHCPS_RECOVERY_ACK(dhcps->dhcps_netif, pmsg_dhcps,
                                        tlen, dhcps->client_address.addr);
#endif
'''


def transform(source: str) -> str:
    """Fail closed on SDK drift; insert only the three documented hook sites."""
    source = source.replace("\r\n", "\n")
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
    if digest != SOURCE_SHA256:
        raise ValueError(f"ESP-IDF DHCP source mismatch: {digest}; expected {SOURCE_SHA256}")
    replacements = (
        ("        first_address.addr = dhcps->dhcps_poll.start_ip.addr;\n",
         BEFORE_REUSE + "\n        first_address.addr = dhcps->dhcps_poll.start_ip.addr;\n"),
        ("        if (dhcps->client_address.addr > dhcps->dhcps_poll.end_ip.addr) {\n",
         FILTER_CANDIDATE + "\n        if (dhcps->client_address.addr > dhcps->dhcps_poll.end_ip.addr) {\n"),
        ("            send_ack(dhcps, pmsg_dhcps, malloc_len);\n",
         ACK_OBSERVER + "            send_ack(dhcps, pmsg_dhcps, malloc_len);\n"),
    )
    for original, replacement in replacements:
        if source.count(original) != 1:
            raise ValueError(f"DHCP hook anchor is not unique: {original.strip()}")
        source = source.replace(original, replacement, 1)
    return source


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error("output must not replace the shared SDK source")
    try:
        generated = transform(args.source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        parser.exit(1, f"USB DHCP recovery generation failed: {error}\n")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if not args.output.is_file() or args.output.read_text(encoding="utf-8") != generated:
        args.output.write_text(generated, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
