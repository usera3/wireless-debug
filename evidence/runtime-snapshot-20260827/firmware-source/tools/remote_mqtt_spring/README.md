# Wireless Debug Production Remote Control

This is the production-oriented remote control stack for multi-user and multi-device operation.

## Stack

- Spring Boot backend with Spring Security, JWT HttpOnly cookie login, Flyway, JPA, PostgreSQL, and MQTT.
- React frontend with login, device list, device details, command panel, and operator command log.
- Mosquitto remains the device-facing MQTT broker.

## Local Run

The WSL environment does not need local Java or Maven when using Docker:

```bash
cd tools/remote_mqtt_spring
docker compose up --build
```

Open:

```text
http://localhost:8081
```

Default local account:

```text
admin@example.com
ChangeMe123!
```

## Device MQTT Topics

The backend subscribes to:

```text
wireless-debug/+/status
wireless-debug/+/availability
wireless-debug/+/ack
```

It publishes commands to:

```text
wireless-debug/{deviceId}/cmd
```

The topic shape is intentionally compatible with the existing ESP32 MQTT firmware work.

## Production Environment Variables

Set these before deployment:

```text
SPRING_DATASOURCE_URL
SPRING_DATASOURCE_USERNAME
SPRING_DATASOURCE_PASSWORD
APP_BOOTSTRAP_ADMIN_EMAIL
APP_BOOTSTRAP_ADMIN_PASSWORD
APP_JWT_SECRET
APP_COOKIE_SECURE=true
APP_MQTT_URL
APP_CORS_ALLOWED_ORIGINS
```

Use a strong unique `APP_JWT_SECRET`; do not keep the compose demo secret in production.

## Security Notes

- Login uses bcrypt password hashes in PostgreSQL.
- Access token is sent as an HttpOnly cookie named `WD_ACCESS_TOKEN`.
- REST APIs require authentication except `/api/auth/login` and `/actuator/health`.
- Commands persist `requestedBy` and `deviceId` for audit.
- TLS termination should be done at the cloud load balancer or reverse proxy.

## Development Checks

Static structural regression:

```bash
node ../../scripts/remote_mqtt_spring_regression.mjs
```

Backend tests from WSL:

```bash
cd backend
MAVEN_OPTS=-Djava.net.preferIPv4Stack=true mvn test
```

Backend tests through Docker, when container outbound networking is reachable:

```bash
docker run --rm --network host -v "$PWD/backend:/workspace" -w /workspace maven:3.9.9-eclipse-temurin-17 mvn test
```

Frontend build from WSL. This copies the React app to a Linux temp directory before installing dependencies, which avoids slow `node_modules` writes under `/mnt/d`:

```bash
../../scripts/remote_mqtt_spring_web_build_tmp.sh
```

For the local WSL host-run setup used during development, run the backend on `localhost:18080` and open the frontend at:

```text
http://localhost:18081
```
