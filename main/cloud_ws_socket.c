#include "cloud_ws_socket.h"

#ifdef ESP_PLATFORM
#include "lwip/sockets.h"
#include "lwip/tcp.h"
#else
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#endif

bool cloud_ws_socket_enable_nodelay(int socket_fd)
{
    if (socket_fd < 0) {
        return false;
    }
    const int enabled = 1;
    return setsockopt(socket_fd, IPPROTO_TCP, TCP_NODELAY,
                      &enabled, sizeof(enabled)) == 0;
}
