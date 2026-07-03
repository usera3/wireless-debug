# Wireless Debug Node-RED Docker

This runs the Wireless Debug Node-RED console as a persistent Docker service.

## Start

```bash
docker compose -f tools/node_red/docker/docker-compose.yml up -d
```

Open:

```text
http://127.0.0.1:1880/wireless-debug
```

The container uses `restart: unless-stopped`, so it starts again when Docker starts.

## Windows Login Startup

This project includes a WSL startup script:

```bash
tools/node_red/docker/start-node-red.sh
```

and a Windows wrapper:

```cmd
tools\node_red\docker\start-node-red.cmd
```

The script starts the Docker daemon if needed and then runs the compose service. A Windows
scheduled task can call the wrapper on login:

```cmd
schtasks /create /tn WirelessDebugNodeRed /sc onlogon /rl LIMITED /f /tr "D:\Users\sunqi39\Desktop\wireless_debug-main\tools\node_red\docker\start-node-red.cmd"
```

## Data And Project Mounts

- Node-RED data: `/home/sunqi39/.node-red` mounted to `/data`
- Project: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main` mounted read-only at the same path
- Serial bridge: host `/dev/ttyS4` mapped to container `/dev/ttyS4`

Use `/dev/ttyS4` in the dashboard serial port field for Windows `COM4` through WSL.

## Stop

```bash
docker compose -f tools/node_red/docker/docker-compose.yml down
```
