import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const files = [
  'tools/remote_mqtt_spring/docker-compose.yml',
  'tools/remote_mqtt_spring/README.md',
  'tools/remote_mqtt_spring/backend/pom.xml',
  'tools/remote_mqtt_spring/backend/Dockerfile',
  'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/RemoteControlApplication.java',
  'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/config/SecurityConfig.java',
  'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/auth/AuthController.java',
  'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/auth/TokenService.java',
  'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/device/DeviceController.java',
  'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/device/DeviceService.java',
  'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/mqtt/MqttGateway.java',
  'tools/remote_mqtt_spring/backend/src/main/resources/db/migration/V1__init.sql',
  'tools/remote_mqtt_spring/backend/src/test/java/com/wirelessdebug/remote/AuthAndDeviceApiTest.java',
  'tools/remote_mqtt_spring/web-react/package.json',
  'tools/remote_mqtt_spring/web-react/Dockerfile',
  'tools/remote_mqtt_spring/web-react/src/main.jsx',
  'tools/remote_mqtt_spring/web-react/src/api/client.js',
  'tools/remote_mqtt_spring/web-react/src/styles.css',
];

for (const file of files) {
  assert.ok(existsSync(resolve(root, file)), `missing ${file}`);
}

const pom = readFileSync(resolve(root, 'tools/remote_mqtt_spring/backend/pom.xml'), 'utf8');
for (const token of [
  'spring-boot-starter-security',
  'spring-boot-starter-oauth2-resource-server',
  'spring-boot-starter-data-jpa',
  'flyway-database-postgresql',
  'postgresql',
  'org.eclipse.paho.client.mqttv3',
]) {
  assert.ok(pom.includes(token), `backend pom missing ${token}`);
}

const security = readFileSync(resolve(root, 'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/config/SecurityConfig.java'), 'utf8');
assert.ok(security.includes('SessionCreationPolicy.STATELESS'), 'backend must be stateless');
assert.ok(security.includes('oauth2ResourceServer'), 'backend must validate JWT tokens through resource server support');
assert.ok(security.includes('BCryptPasswordEncoder(12)'), 'backend must bcrypt passwords with strength 12');

const tokenService = readFileSync(resolve(root, 'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/auth/TokenService.java'), 'utf8');
assert.ok(tokenService.includes('WD_ACCESS_TOKEN'), 'auth cookie name missing');
assert.ok(tokenService.includes('.httpOnly(true)'), 'auth cookie must be HttpOnly');
assert.ok(tokenService.includes('.sameSite("Lax")'), 'auth cookie must set SameSite Lax');

const migration = readFileSync(resolve(root, 'tools/remote_mqtt_spring/backend/src/main/resources/db/migration/V1__init.sql'), 'utf8');
for (const table of ['user_accounts', 'devices', 'device_commands']) {
  assert.ok(migration.includes(`create table ${table}`), `migration missing ${table}`);
}

const deviceEntity = readFileSync(resolve(root, 'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/device/Device.java'), 'utf8');
const commandEntity = readFileSync(resolve(root, 'tools/remote_mqtt_spring/backend/src/main/java/com/wirelessdebug/remote/device/DeviceCommand.java'), 'utf8');
assert.ok(!deviceEntity.includes('@Lob'), 'PostgreSQL text columns must not be mapped as @Lob in Device');
assert.ok(!commandEntity.includes('@Lob'), 'PostgreSQL text columns must not be mapped as @Lob in DeviceCommand');
assert.ok(deviceEntity.includes('@Column(name = "status_json", columnDefinition = "text")'), 'status_json must map to PostgreSQL text');
assert.ok(commandEntity.includes('@Column(name = "args_json", nullable = false, columnDefinition = "text")'), 'args_json must map to PostgreSQL text');
assert.ok(commandEntity.includes('@Column(name = "ack_message", columnDefinition = "text")'), 'ack_message must map to PostgreSQL text');

const backendTests = readFileSync(resolve(root, 'tools/remote_mqtt_spring/backend/src/test/java/com/wirelessdebug/remote/AuthAndDeviceApiTest.java'), 'utf8');
assert.ok(backendTests.includes('unauthenticatedDevicesRequestIsRejected'), 'backend must test unauthenticated device rejection');
assert.ok(backendTests.includes('loginReturnsHttpOnlyCookieAndAuthenticatedUserCanReadDevices'), 'backend must test login cookie flow');
assert.ok(backendTests.includes('commandRequestsPersistOperatorAndDeviceIntent'), 'backend must test command audit contract');

const app = readFileSync(resolve(root, 'tools/remote_mqtt_spring/web-react/src/main.jsx'), 'utf8');
for (const token of [
  'LoginScreen',
  '无线调试云控制台',
  '设备',
  '远程控制',
  '操作记录',
  'query_status',
  'set_wifi_mode',
  'set_uart_baud',
  'display_text',
  'requestedBy',
]) {
  assert.ok(app.includes(token), `React app missing ${token}`);
}

const api = readFileSync(resolve(root, 'tools/remote_mqtt_spring/web-react/src/api/client.js'), 'utf8');
assert.ok(api.includes("credentials: 'include'"), 'frontend must include auth cookie credentials');
assert.ok(api.includes("http://localhost:8080"), 'frontend default API base must use localhost for WSL browser compatibility');
assert.ok(!api.includes("http://127.0.0.1:8080"), 'frontend default API base must not use 127.0.0.1');

const compose = readFileSync(resolve(root, 'tools/remote_mqtt_spring/docker-compose.yml'), 'utf8');
for (const service of ['postgres:', 'mosquitto:', 'backend:', 'web:']) {
  assert.ok(compose.includes(service), `compose missing ${service}`);
}
assert.ok(compose.includes('APP_JWT_SECRET'), 'compose must expose JWT secret config');

console.log('remote MQTT Spring production regression passed');
