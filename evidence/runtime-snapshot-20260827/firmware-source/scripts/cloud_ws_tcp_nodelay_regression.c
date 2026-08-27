#include "cloud_ws_socket.h"

#include <assert.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void)
{
    assert(!cloud_ws_socket_enable_nodelay(-1));

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    assert(fd >= 0);

    int enabled = 0;
    socklen_t enabled_len = sizeof(enabled);
    assert(getsockopt(fd, IPPROTO_TCP, TCP_NODELAY,
                      &enabled, &enabled_len) == 0);
    assert(enabled == 0);

    assert(cloud_ws_socket_enable_nodelay(fd));
    enabled = 0;
    enabled_len = sizeof(enabled);
    assert(getsockopt(fd, IPPROTO_TCP, TCP_NODELAY,
                      &enabled, &enabled_len) == 0);
    assert(enabled == 1);

    close(fd);
    puts("cloud websocket TCP_NODELAY regression: PASS");
    return 0;
}
