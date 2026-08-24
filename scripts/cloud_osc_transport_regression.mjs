import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';

const source = readFileSync('main/cloud_mqtt.c', 'utf8');
const uplink = readFileSync('main/cloud_ws_uplink.c', 'utf8');
const mainSource = readFileSync('main/main.c', 'utf8');
const manifest = readFileSync('main/idf_component.yml', 'utf8');
const cmake = readFileSync('main/CMakeLists.txt', 'utf8');
const wifiTransport = readFileSync('main/wifi_transport.c', 'utf8');
const webApi = readFileSync('main/web_api.c', 'utf8');
const sdkconfig = readFileSync('sdkconfig', 'utf8');
const sdkconfigFiles = [['sdkconfig', sdkconfig]];
if (existsSync('sdkconfig.auth.local')) {
  sdkconfigFiles.push(['sdkconfig.auth.local', readFileSync('sdkconfig.auth.local', 'utf8')]);
}
const cloudApp = readFileSync('tools/remote_mqtt_python/app.py', 'utf8');
const cloudDockerfile = readFileSync('tools/remote_mqtt_python/Dockerfile', 'utf8');
const cloudCompose = readFileSync('tools/remote_mqtt_python/docker-compose.yml', 'utf8');
const cloudEnvExample = readFileSync('tools/remote_mqtt_python/.env.example', 'utf8');
const senderTaskBody = uplink.match(
  /static void sender_task\(void \*arg\)\n\{([\s\S]*?)\n\}/,
)?.[1] || '';
const connectedEventBody = uplink.match(
  /if \(event_id == WEBSOCKET_EVENT_CONNECTED\) \{([\s\S]*?)\} else if \(event_id == WEBSOCKET_EVENT_DISCONNECTED\)/,
)?.[1] || '';
const firmwareMessageBytes = Number(
  uplink.match(/#define CLOUD_WS_UPLINK_SEND_FRAME_MAX (\d+)U/)?.[1] || 0,
);
const uplinkTaskStackBytes = Number(
  uplink.match(/#define CLOUD_WS_UPLINK_TASK_STACK_BYTES (\d+)U/)?.[1] || 0,
);
const cloudMessageLimits = {
  app: Number(cloudApp.match(/CLOUD_WS_MAX_MESSAGE_BYTES', '(\d+)'/)?.[1] || 0),
  compose: Number(cloudCompose.match(/CLOUD_WS_MAX_MESSAGE_BYTES:-([0-9]+)/)?.[1] || 0),
  envExample: Number(cloudEnvExample.match(/CLOUD_WS_MAX_MESSAGE_BYTES=([0-9]+)/)?.[1] || 0),
};
assert.ok(firmwareMessageBytes > 0, 'firmware WebSocket aggregate limit must be discoverable');
for (const [sourceName, cloudMessageBytes] of Object.entries(cloudMessageLimits)) {
  assert.ok(
    cloudMessageBytes >= firmwareMessageBytes,
    `${sourceName} cloud WebSocket message limit must accept the firmware aggregate frame`,
  );
}

assert.match(
  sdkconfig,
  /CONFIG_LWIP_TCP_SND_BUF_DEFAULT=32768/,
  'WAN waveform uplink needs a TCP send window large enough to keep data in flight',
);
assert.match(
  sdkconfig,
  /CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y/,
  'larger Wi-Fi and lwIP buffers must prefer PSRAM to protect internal RAM',
);
for (const [configName, configText] of sdkconfigFiles) {
  assert.match(
    configText,
    /CONFIG_CLOUD_WS_UPLINK_URI="ws:\/\/43\.153\.137\.20:18089"/,
    `${configName} binary WebSocket uplink must bypass the public TLS chain and use the cloud bridge directly`,
  );
  assert.doesNotMatch(
    configText,
    /CONFIG_CLOUD_WS_UPLINK_URI="wss:\/\/wd\.claudcode\.xyz"/,
    `${configName} must not point ESP32 waveform uplink at the TLS endpoint that fails the ESP-IDF handshake`,
  );
}

assert.match(
  uplink,
  /#define CLOUD_WS_UPLINK_SEND_TIMEOUT_MS 1000/,
  'cloud websocket network operations must tolerate normal WAN latency',
);

assert.match(
  source,
  /static void publish_ws_frame\([\s\S]*while \(offset < len\)[\s\S]*if \(!osc_streaming \|\| !cloud_ws_uplink_send\(data \+ offset, chunk_len\)\)[\s\S]*cloud_mqtt_publish_ws_fallback\(data \+ offset, chunk_len, NULL\)/,
  'active osc UART chunks must use MQTT only when the binary uplink cannot accept the newest frame',
);
const localStatusBody = webApi.match(
  /static esp_err_t device_status_handler\(httpd_req_t \*req\)\n\{([\s\S]*?)\n\}/,
)?.[1] || '';
for (const token of [
  'cloud_ws_uplink_get_stats(&uplink)',
  'cloud_ws_uplink',
  'schema_version',
  'CLOUD_WS_UPLINK_SCHEMA_VERSION',
  'compression_capable',
  'compression_active',
  'compression_calls',
  'compressed_frames',
  'raw_envelope_frames',
  'compression_failures',
  'raw_bytes',
  'wire_bytes',
  'compression_total_us',
  'compression_max_us',
  'queued_fallback_frames',
  'fallback_failures',
  'stop_dropped_frames',
  'connect_events',
  'disconnect_events',
  'error_events',
  'closed_events',
  'last_event_id',
  'overload_dropped_frames',
  'queue_pending_frames',
]) {
  assert.ok(localStatusBody.includes(token), `local device status missing uplink field: ${token}`);
}
const overloadSendBody = uplink.match(
  /bool cloud_ws_uplink_send\(const uint8_t \*data, size_t len\)\n\{([\s\S]*?)\n\}/,
)?.[1] || '';
assert.match(
  overloadSendBody,
  /xQueueSend\(s_queue, &frame, 0\)[\s\S]*s_connected[\s\S]*xQueueReceive\(s_queue, &dropped, 0\)[\s\S]*overload_dropped_frames[\s\S]*xQueueSend\(s_queue, &frame, 0\)/,
  'connected queue overload must evict the oldest waveform frame and retry the newest frame',
);
for (const token of [
  'WEBSOCKET_EVENT_CONNECTED',
  'WEBSOCKET_EVENT_DISCONNECTED',
  'WEBSOCKET_EVENT_ERROR',
  'WEBSOCKET_EVENT_CLOSED',
  'connect_events',
  'disconnect_events',
  'error_events',
  'closed_events',
  'last_event_id',
]) {
  assert.ok(uplink.includes(token), `uplink lifecycle telemetry missing: ${token}`);
}
assert.match(
  localStatusBody,
  /int written = snprintf\(resp, sizeof\(resp\),[\s\S]*if \(written < 0 \|\| \(size_t\)written >= sizeof\(resp\)\)[\s\S]*httpd_resp_send_err/,
  'local status must fail explicitly instead of returning truncated JSON',
);
const publishWsFrameBody = source.match(
  /static void publish_ws_frame\(const uint8_t \*data, size_t len\)\n\{([\s\S]*?)\n\}/,
)?.[1] || '';
assert.ok(
  !publishWsFrameBody.includes('!s_connected') && !publishWsFrameBody.includes('s_client == NULL'),
  'binary WebSocket uplink must remain usable during a transient MQTT disconnect',
);
assert.match(
  publishWsFrameBody,
  /while \(offset < len\)[\s\S]*size_t chunk_len = MIN\(len - offset, CLOUD_MQTT_WS_FRAME_MAX_LEN\)[\s\S]*cloud_ws_uplink_send\(data \+ offset, chunk_len\)/,
  'large UART callbacks must be split into bounded cloud uplink chunks instead of being discarded',
);
assert.ok(
  !publishWsFrameBody.includes('len > CLOUD_MQTT_WS_FRAME_MAX_LEN'),
  'cloud UART publisher must not reject complete UART callbacks larger than one uplink chunk',
);
assert.match(
  source,
  /static bool publish_ws_frame_mqtt\([\s\S]*ws_osc_state_snapshot\(&osc_streaming, &active_until_us\)[\s\S]*osc_streaming[\s\S]*esp_mqtt_client_enqueue\([\s\S]*s_client, s_pub_topic, json, 0, 0, 0, true\)/,
  'active osc MQTT fallback must enqueue QoS 0 frames for asynchronous delivery',
);
assert.match(
  source,
  /is_osc_stop_frame[\s\S]*ws_osc_state_set\(false, 0\)/,
  'receiving an osc stop frame must immediately close the cloud osc uplink window',
);
assert.match(
  source,
  /is_osc_stop_frame[\s\S]*cloud_ws_uplink_set_active\(false\)/,
  'receiving an osc stop frame must stop the on-demand binary uplink',
);
assert.match(
  source,
  /is_osc_start_frame[\s\S]*ws_osc_state_set\([\s\S]*CLOUD_MQTT_WS_ACTIVE_US/,
  'receiving an osc start frame must mark subsequent UART chunks as real-time osc traffic',
);
assert.match(
  source,
  /is_osc_start_frame[\s\S]*cloud_ws_uplink_set_active\(osc_streaming\)/,
  'receiving an osc start frame must start the on-demand binary uplink',
);
assert.match(
  source,
  /status_timer_cb[\s\S]*ws_osc_state_expire\(esp_timer_get_time\(\)\)[\s\S]*cloud_ws_uplink_set_active\(false\)/,
  'expired cloud osc heartbeat window must automatically stop the binary uplink',
);
for (const token of [
  'static portMUX_TYPE s_ws_osc_state_lock = portMUX_INITIALIZER_UNLOCKED',
  'ws_osc_state_set',
  'ws_osc_state_snapshot',
  'ws_osc_state_expire',
  'ws_osc_state_refresh',
]) {
  assert.ok(source.includes(token), `cloud osc activity state missing synchronized helper: ${token}`);
}
for (const helper of [
  'ws_osc_state_set',
  'ws_osc_state_snapshot',
  'ws_osc_state_expire',
  'ws_osc_state_refresh',
]) {
  const body = source.match(new RegExp(`static [^{]+ ${helper}\\([^)]*\\)\\n\\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
  assert.ok(
    body.includes('portENTER_CRITICAL(&s_ws_osc_state_lock)') &&
      body.includes('portEXIT_CRITICAL(&s_ws_osc_state_lock)'),
    `${helper} must access the 64-bit osc deadline under the dedicated critical section`,
  );
}
const busWsFrameBody = source.match(
  /static void handle_bus_ws_frame\([^)]*\)\n\{([\s\S]*?)\n\}/,
)?.[1] || '';
assert.match(
  busWsFrameBody,
  /bool osc_streaming = ws_osc_state_refresh\([\s\S]*is_osc_start_frame\(frame, frame_len\),[\s\S]*cloud_ws_uplink_set_active\(osc_streaming\)/,
  'heartbeat refresh and uplink activation must use one atomic osc-state transition result',
);
assert.ok(
  !busWsFrameBody.includes('ws_osc_state_snapshot') && !busWsFrameBody.includes('ws_osc_state_set(osc_streaming'),
  'bus frame handling must not snapshot and later overwrite concurrently expired osc state',
);
for (const functionName of ['status_timer_cb', 'publish_ws_frame_mqtt', 'publish_ws_frame', 'handle_bus_ws_frame']) {
  const body = source.match(new RegExp(`static [^{]+ ${functionName}\\([^)]*\\)\\n\\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
  assert.ok(
    !body.includes('s_ws_active_until_us') && !body.includes('s_ws_osc_streaming'),
    `${functionName} must not directly race on the cloud osc activity state`,
  );
}
assert.ok(manifest.includes('espressif/esp_websocket_client: ^1.7.0'), 'managed WebSocket client dependency missing');
assert.ok(cmake.includes('cloud_ws_uplink.c'), 'cloud WebSocket uplink source missing from component build');
assert.ok(cmake.includes('cloud_waveform_codec.c'), 'cloud waveform codec source missing from component build');
assert.ok(cmake.includes('mbedtls'), 'firmware waveform codec must link the miniz provider');
for (const token of [
  'esp_websocket_client_init',
  'esp_websocket_client_start',
  'esp_websocket_client_send_bin',
  'esp_crt_bundle_attach',
  'cloud_waveform_encode',
  'cloud_waveform_codec_init',
  'cloud_waveform_codec_deinit',
  's_wire_buffer',
  'compression_capable',
  'compression_active',
  'WEBSOCKET_EVENT_DATA',
  '"WDC1"',
  '/ws/uplink/',
  'cloud_ws_uplink_notify_wifi_state',
  'cloud_ws_uplink_get_stats',
  'queue_full',
  'fallback_frames',
  'queued_fallback_frames',
  'fallback_failures',
  'stop_dropped_frames',
  'CLOUD_WS_UPLINK_SCHEMA_VERSION',
  'add_cloud_ws_uplink_status',
  '"cloud_ws_uplink"',
  'cloud_ws_uplink_set_active',
  'xQueueCreateWithCaps',
  'MALLOC_CAP_SPIRAM',
  'vQueueDeleteWithCaps',
  'portMUX_INITIALIZER_UNLOCKED',
  'queue_in_psram',
  'sender_stack_min_free',
  'uxTaskGetStackHighWaterMark',
]) {
  assert.ok(
    uplink.includes(token) || mainSource.includes(token) || source.includes(token),
    `firmware binary uplink missing token: ${token}`,
  );
}
assert.match(
  connectedEventBody,
  /s_compression_capable = true[\s\S]*xTaskNotifyGive\(s_sender_task\)/,
  'firmware must request compressed envelopes immediately after the cloud uplink connects',
);
assert.match(
  uplink,
  /WEBSOCKET_EVENT_DATA[\s\S]*memcmp\(data->data_ptr, "WDC1", 4\)[\s\S]*s_compression_capable = true/,
  'firmware must still accept the cloud WDC1 capability marker for compatibility',
);
assert.match(
  senderTaskBody,
  /s_connected[\s\S]*compression_capable[\s\S]*!compression_active[\s\S]*esp_websocket_client_send_bin\([\s\S]*"WDC1"[\s\S]*s_compression_active = true/,
  'firmware must acknowledge WDC1 before sending WDZ1 envelopes',
);
assert.match(
  senderTaskBody,
  /if \(compression_active\)[\s\S]*cloud_waveform_encode\([\s\S]*s_wire_buffer[\s\S]*send_ptr = s_wire_buffer/,
  'firmware must encode aggregated osc payloads into negotiated waveform envelopes',
);
assert.ok(
  !uplink.includes('Authorization: Bearer') && !uplink.includes('CLOUD_WS_UPLINK_TOKEN'),
  'waveform compression must not require device transport authentication',
);
assert.match(
  uplink,
  /#include "esp_crt_bundle.h"[\s\S]*\.crt_bundle_attach\s*=\s*esp_crt_bundle_attach/,
  'WSS cloud uplink must attach the ESP-IDF certificate bundle when using the production domain',
);
assert.match(
  uplink,
  /\.task_stack\s*=\s*CLOUD_WS_UPLINK_TASK_STACK_BYTES/,
  'websocket client task must share the uplink stack budget constant',
);
assert.ok(
  uplinkTaskStackBytes >= 12288,
  'compressed cloud uplink needs at least 12KB stack headroom during miniz encoding',
);
assert.match(
  uplink,
  /xQueueCreateWithCaps\([\s\S]*MALLOC_CAP_SPIRAM[\s\S]*if \(s_queue == NULL\)[\s\S]*xQueueCreateWithCaps\([\s\S]*MALLOC_CAP_INTERNAL/,
  'waveform queue must prefer PSRAM and retain an internal-RAM allocation fallback',
);
assert.match(
  source,
  /cJSON_AddNumberToObject\(obj, "schema_version", CLOUD_WS_UPLINK_SCHEMA_VERSION\)/,
  'device status must expose an explicit binary-uplink telemetry schema version',
);
assert.match(
  uplink,
  /static void sender_task\([\s\S]*uxQueueMessagesWaiting\(s_queue\) == 0[\s\S]*ulTaskNotifyTake\(pdTRUE, portMAX_DELAY\)[\s\S]*active = s_active[\s\S]*s_wifi_ready && active[\s\S]*esp_websocket_client_start[\s\S]*esp_websocket_client_stop[\s\S]*xQueueReceive\(s_queue, &chunk, 0\)/,
  'one notification-driven worker must own WebSocket lifecycle and non-blocking queue draining',
);
assert.equal(
  [...senderTaskBody.matchAll(/while \(xQueueReceive\(s_queue, &chunk, 0\) == pdTRUE\)/g)].length,
  1,
  'only the explicit-stop cleanup path may drain multiple queued frames in one worker iteration',
);
assert.match(
  senderTaskBody,
  /if \(!active\) \{[\s\S]*while \(xQueueReceive\(s_queue, &chunk, 0\) == pdTRUE\)[\s\S]*stats_increment\(&s_stats\.stop_dropped_frames, dropped\)[\s\S]*continue;[\s\S]*if \(xQueueReceive\(s_queue, &chunk, 0\)/,
  'explicit osc stop must count each stale frame it removes, including concurrent late enqueues',
);
assert.ok(
  !senderTaskBody.includes('xQueueReset(s_queue)'),
  'explicit stop must not reset the queue after a non-atomic length snapshot',
);
assert.ok(
  !uplink.includes('lifecycle_task') && !uplink.includes('s_lifecycle_task'),
  'binary uplink must not allocate a second lifecycle task stack',
);
assert.equal(
  [...uplink.matchAll(/xTaskCreate\(/g)].length,
  1,
  'binary uplink must create exactly one worker task',
);
for (const api of ['cloud_ws_uplink_notify_wifi_state', 'cloud_ws_uplink_set_active']) {
  const body = uplink.match(new RegExp(`void ${api}\\([^)]*\\)\\n\\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
  assert.ok(
    body.includes('portENTER_CRITICAL(&s_state_lock)') &&
      body.includes('portEXIT_CRITICAL(&s_state_lock)') &&
      body.includes('xTaskNotifyGive(s_sender_task)') &&
      !body.includes('esp_websocket_client_start') &&
      !body.includes('esp_websocket_client_stop'),
    `${api} must only update desired state and wake the unified worker task`,
  );
}
assert.ok(
  !uplink.includes('xSemaphoreTake') && !uplink.includes('xSemaphoreCreateMutex'),
  'timer-reachable uplink state updates must not block on a FreeRTOS mutex',
);
const uplinkSendBody = uplink.match(
  /bool cloud_ws_uplink_send\([^)]*\)\n\{([\s\S]*?)\n\}/,
)?.[1] || '';
assert.ok(
  uplinkSendBody.includes('xQueueSend(s_queue, &frame, 0)') &&
    uplinkSendBody.includes('xTaskNotifyGive(s_sender_task)'),
  'queued waveform frames must wake the unified worker task',
);
assert.match(
  uplinkSendBody,
  /if \(xQueueSend\(s_queue, &frame, 0\) != pdTRUE\)[\s\S]*if \(!s_connected \|\| xQueueReceive/,
  'transient disconnects may continue buffering until queue overload requires MQTT fallback',
);
assert.ok(
  uplink.includes('#define CLOUD_WS_UPLINK_QUEUE_DEPTH 64U'),
  'cloud binary uplink queue must absorb mobile-network jitter without blocking UART',
);
assert.ok(
  uplink.includes('#define CLOUD_WS_UPLINK_SEND_FRAME_MAX 8192U'),
  'cloud worker must aggregate raw chunks into larger binary WebSocket frames',
);
assert.match(
  uplink,
  /s_send_frame\s*=\s*heap_caps_calloc\([\s\S]*MALLOC_CAP_SPIRAM[\s\S]*if \(s_send_frame == NULL\)[\s\S]*heap_caps_calloc\([\s\S]*MALLOC_CAP_INTERNAL/,
  'large aggregation buffer must prefer PSRAM and retain an internal-RAM fallback',
);
assert.match(
  senderTaskBody,
  /cloud_ws_uplink_frame_t next[\s\S]*xQueuePeek\(s_queue, &next,[\s\S]*frame->len \+ next\.len <= CLOUD_WS_UPLINK_SEND_FRAME_MAX[\s\S]*xQueueReceive\(s_queue, &next, 0\)[\s\S]*memcpy\(frame->data \+ frame->len/,
  'cloud uplink worker must coalesce adjacent UART chunks before binary send',
);
assert.match(
  uplink,
  /xTaskCreate\(sender_task, "cloud_ws_tx", CLOUD_WS_UPLINK_TASK_STACK_BYTES/,
  'cloud uplink sender stack must use the shared budget constant because compression consumes stack',
);
assert.match(
  uplink,
  /\.buffer_size\s*=\s*CLOUD_WS_UPLINK_SEND_FRAME_MAX/,
  'websocket TX buffer must fit one aggregated uplink message without four internal writes',
);
assert.match(
  mainSource,
  /cloud_ws_uplink_config_t[\s\S]*CONFIG_CLOUD_WS_UPLINK_URI[\s\S]*s_cloud_device_id[\s\S]*cloud_ws_uplink_init/,
  'application startup must initialize the binary WebSocket uplink with URI and device identity',
);
assert.ok(
  !mainSource.includes('.token =') && !mainSource.includes('CONFIG_CLOUD_WS_UPLINK_TOKEN'),
  'application startup must keep the current no-auth cloud uplink contract',
);
assert.match(
  mainSource,
  /HTTPD_DEFAULT_CONFIG\(\)[\s\S]*config\.task_priority\s*=\s*9/,
  'HTTPD task must outrank UART routing so queued WebSocket sends drain promptly',
);
assert.match(
  readFileSync('main/uart_transport.c', 'utf8'),
  /#define UART_TRANSPORT_TASK_PRIORITY\s+10/,
  'UART reader must outrank HTTPD to protect the 2 Mbps hardware receive path from overflow',
);
assert.match(
  readFileSync('main/uart_transport.c', 'utf8'),
  /#define UART_TRANSPORT_RX_FULL_THRESHOLD\s+64/,
  'UART RX interrupt threshold must leave enough FIFO headroom for WiFi interrupt jitter at 2 Mbps',
);
assert.match(
  wifiTransport,
  /xTaskCreate\(wifi_send_task,[\s\S]*4096,[\s\S]*7,/,
  'WiFi staging task must not starve the UART reader or the HTTPD sender task',
);
for (const token of [
  '#define WIFI_TRANSPORT_FRAME_POOL_SIZE 96',
  'xQueueCreateWithCaps',
  'MALLOC_CAP_SPIRAM',
  'heap_caps_calloc',
  'portMUX_INITIALIZER_UNLOCKED',
  'wifi_frame_merge',
  'WIFI_TRANSPORT_COALESCE_WAIT_MS',
]) {
  assert.ok(wifiTransport.includes(token), `local WebSocket burst buffer missing token: ${token}`);
}
assert.match(
  wifiTransport,
  /static bool wifi_frame_merge\([\s\S]*target->len \+ source->len > WIFI_TRANSPORT_FRAME_MAX_LEN[\s\S]*memcpy\(target->data \+ target->len[\s\S]*frame_release\(source\)/,
  'WiFi sender must coalesce adjacent UART chunks before scheduling HTTPD work',
);
assert.match(
  wifiTransport,
  /xQueuePeek\(s_send_queue, &next,[\s\S]*pdMS_TO_TICKS\(WIFI_TRANSPORT_COALESCE_WAIT_MS\)\)[\s\S]*xQueueReceive\(s_send_queue, &next, 0\)[\s\S]*wifi_frame_merge\(frame, next\)/,
  'WiFi sender must wait briefly for adjacent UART chunks instead of only merging an existing backlog',
);
assert.ok(
  !wifiTransport.includes('xSemaphoreTake(s_pool_mutex') &&
    !wifiTransport.includes('xSemaphoreCreateMutex'),
  'UART-to-WiFi frame allocation must not block on a mutex during high-rate bursts',
);
assert.match(
  mainSource,
  /\.fallback = cloud_mqtt_publish_ws_fallback/,
  'async binary WebSocket send failures must fall back to the MQTT waveform publisher',
);
assert.match(
  source,
  /bool cloud_mqtt_publish_ws_fallback\([\s\S]*if \(!publish_ws_frame_mqtt\(data, len\)\)[\s\S]*cloud_ws_uplink_note_fallback_failure\(\)[\s\S]*return false;[\s\S]*cloud_ws_uplink_note_fallback\(\)[\s\S]*return true;/,
  'MQTT fallback must be counted only after the broker accepts the publish',
);
assert.match(
  source,
  /static bool publish_ws_frame_mqtt\([\s\S]*int message_id = osc_streaming[\s\S]*esp_mqtt_client_enqueue\([\s\S]*esp_mqtt_client_publish\([\s\S]*published = message_id >= 0;[\s\S]*return published;/,
  'MQTT waveform publisher must expose enqueue success to fallback accounting',
);
assert.match(
  uplink,
  /void cloud_ws_uplink_note_fallback\(void\)[\s\S]*stats_increment\(&s_stats\.fallback_frames, 1\)/,
  'all MQTT waveform fallbacks must be observable in uplink telemetry',
);
assert.match(
  uplink,
  /void cloud_ws_uplink_note_fallback_failure\(void\)[\s\S]*stats_increment\(&s_stats\.fallback_failures, 1\)/,
  'failed MQTT waveform fallbacks must be observable in uplink telemetry',
);
assert.match(
  uplink,
  /static void fallback_frame\([\s\S]*while \(offset < frame->len\)[\s\S]*s_config\.fallback\(frame->data \+ offset, chunk_len[\s\S]*if \(complete\)[\s\S]*stats_increment\(&s_stats\.queued_fallback_frames, frame->source_frames\)/,
  'successful fallback of an already queued frame must be tracked separately',
);

for (const token of [
  'from waveform_codec import CAPABILITY_MARKER, WaveformCodecError, decode_uplink_message',
  'waveform_codec_metrics',
  'note_waveform_activation',
  'note_waveform_decode',
  'note_waveform_decode_failure',
  'waveform_codec_snapshot_locked',
  'connection.send(CAPABILITY_MARKER)',
  'envelope_active = False',
  'decode_uplink_message(data, envelope_active)',
  'result.activate',
  'broadcast_remote_ws_bytes(device_id, result.payload)',
]) {
  assert.ok(cloudApp.includes(token), `cloud app missing no-auth waveform codec token: ${token}`);
}
assert.ok(
  !cloudApp.includes('uplink_device_from_request') && !cloudApp.includes('CLOUD_WS_UPLINK_TOKEN'),
  'cloud app must not require uplink bearer-token auth for the current product version',
);
assert.ok(
  cloudDockerfile.includes('waveform_codec.py'),
  'cloud Docker image must copy waveform_codec.py into the runtime image',
);

console.log('cloud osc transport regression passed');
