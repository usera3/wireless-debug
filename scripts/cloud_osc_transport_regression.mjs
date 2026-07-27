import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync('main/cloud_mqtt.c', 'utf8');
const uplink = readFileSync('main/cloud_ws_uplink.c', 'utf8');
const uplinkHeader = readFileSync('main/cloud_ws_uplink.h', 'utf8');
const compressionStateHeader = readFileSync('main/cloud_ws_compression_state.h', 'utf8');
const leaseHeader = readFileSync('main/cloud_ws_lease.h', 'utf8');
const downlinkHeader = readFileSync('main/cloud_ws_downlink_reassembly.h', 'utf8');
const mainSource = readFileSync('main/main.c', 'utf8');
const manifest = readFileSync('main/idf_component.yml', 'utf8');
const cmake = readFileSync('main/CMakeLists.txt', 'utf8');
const wifiTransport = readFileSync('main/wifi_transport.c', 'utf8');
const webApi = readFileSync('main/web_api.c', 'utf8');
const sdkconfig = readFileSync('sdkconfig', 'utf8');

assert.match(
  sdkconfig,
  /CONFIG_LWIP_TCP_SND_BUF_DEFAULT=32768/,
  'WAN waveform uplink needs a TCP send window large enough to keep data in flight',
);

assert.ok(
  uplinkHeader.includes('#define CLOUD_WS_UPLINK_SCHEMA_VERSION 5U'),
  'raw duplex downlink telemetry must use schema version 5',
);
for (const token of [
  'cloud_ws_uplink_downlink_fn_t',
  'on_downlink',
  'downlink_ctx',
  'downlink_frames',
  'downlink_bytes',
  'downlink_failures',
]) {
  assert.ok(uplinkHeader.includes(token), `firmware downlink API missing token: ${token}`);
}
for (const token of [
  'CLOUD_WS_DOWNLINK_MAX_BYTES 512U',
  'cloud_ws_downlink_reassembly_t',
  'cloud_ws_downlink_reassembly_push',
  'CLOUD_WS_DOWNLINK_COMPLETE',
  'CLOUD_WS_DOWNLINK_REJECTED',
]) {
  assert.ok(downlinkHeader.includes(token), `bounded downlink reassembly missing token: ${token}`);
}
assert.match(
  uplink,
  /handle_downlink_data[\s\S]*cloud_ws_downlink_reassembly_push[\s\S]*CLOUD_WS_DOWNLINK_COMPLETE[\s\S]*cloud_ws_compression_accept_reply[\s\S]*s_config\.on_downlink/,
  'completed binary websocket downlink messages must invoke the configured callback',
);
assert.ok(
  compressionStateHeader.includes('CLOUD_WS_CAPABILITY "WDC1"') &&
    compressionStateHeader.includes('cloud_ws_compression_take_offer') &&
    compressionStateHeader.includes('cloud_ws_compression_accept_reply') &&
    compressionStateHeader.includes('cloud_ws_compression_on_disconnected'),
  'compression negotiation must use the tested connection-local state machine',
);
assert.match(
  uplink,
  /WEBSOCKET_EVENT_DATA[\s\S]*handle_downlink_data/,
  'binary websocket data events must enter the bounded downlink handler',
);
assert.match(
  mainSource,
  /cloud_handle_ws_downlink[\s\S]*cloud_mqtt_note_realtime_control\(data, len\)[\s\S]*cloud_send_ws_frame\(data, len, ctx\)/,
  'direct cloud frames must refresh the response lease before UART forwarding',
);
assert.match(
  mainSource,
  /cloud_ws_uplink_config_t[\s\S]*\.on_downlink = cloud_handle_ws_downlink[\s\S]*\.downlink_ctx = NULL/,
  'application startup must wire the raw WSS downlink callback',
);
for (const token of ['downlink_frames', 'downlink_bytes', 'downlink_failures']) {
  assert.ok(source.includes(token), `cloud status missing ${token}`);
  assert.ok(webApi.includes(token), `local status missing ${token}`);
}
assert.match(
  sdkconfig,
  /CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y/,
  'larger Wi-Fi and lwIP buffers must prefer PSRAM to protect internal RAM',
);

assert.match(
  uplink,
  /#define CLOUD_WS_UPLINK_SEND_TIMEOUT_MS 5000/,
  'cloud websocket network operations must tolerate normal WAN latency',
);

assert.match(
  source,
  /static void publish_ws_frame\([\s\S]*while \(offset < len\)[\s\S]*cloud_ws_uplink_send\(data \+ offset, chunk_len\)/,
  'active cloud UART chunks must use the binary uplink',
);
const localStatusBody = webApi.match(
  /static esp_err_t device_status_handler\(httpd_req_t \*req\)\n\{([\s\S]*?)\n\}/,
)?.[1] || '';
for (const token of [
  'cloud_ws_uplink_get_stats(&uplink)',
  'cloud_ws_uplink',
  'schema_version',
  'CLOUD_WS_UPLINK_SCHEMA_VERSION',
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
  /xQueueSend\(s_queue, &frame, 0\)[\s\S]*xQueueReceive\(s_queue, &dropped, 0\)[\s\S]*overload_dropped_frames[\s\S]*xQueueSend\(s_queue, &frame, 0\)/,
  'queue overload must evict the oldest cloud UART frame and retry the newest frame',
);
assert.ok(
  !overloadSendBody.includes('!s_connected'),
  'a disconnected uplink must retain the newest bounded data instead of rejecting it',
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
  publishWsFrameBody,
  /\(void\)cloud_ws_uplink_send\(data \+ offset, chunk_len\)/,
  'cloud UART data must be dropped when the binary uplink cannot accept it',
);
assert.ok(
  !publishWsFrameBody.includes('publish_ws_frame_mqtt') &&
    !publishWsFrameBody.includes('cloud_mqtt_publish_ws_fallback') &&
    !publishWsFrameBody.includes('!osc_streaming'),
  'active parameter responses must never fall back to MQTT',
);
assert.match(
  source,
  /is_osc_stop_frame[\s\S]*ws_osc_state_set\(false, 0\)/,
  'receiving an osc stop frame must immediately close the cloud osc uplink window',
);
assert.match(
  source,
  /is_osc_stop_frame[\s\S]*lease_generation = ws_osc_state_set\(false, 0\)[\s\S]*cloud_ws_uplink_set_active\(false, lease_generation\)/,
  'receiving an osc stop frame must stop the on-demand binary uplink',
);
assert.match(
  source,
  /is_osc_start_frame[\s\S]*ws_osc_state_set\([\s\S]*CLOUD_MQTT_WS_ACTIVE_US/,
  'receiving an osc start frame must mark subsequent UART chunks as real-time osc traffic',
);
assert.match(
  source,
  /is_osc_start_frame[\s\S]*lease_generation = ws_osc_state_refresh\([\s\S]*cloud_ws_uplink_set_active\(true, lease_generation\)/,
  'every non-stop cloud UART request must open the binary uplink data window',
);
assert.match(
  source,
  /status_timer_cb[\s\S]*lease_generation = ws_osc_state_expire\(esp_timer_get_time\(\)\)[\s\S]*cloud_ws_uplink_set_active\(false, lease_generation\)/,
  'expired cloud osc heartbeat window must automatically stop the binary uplink',
);
const expireBody = source.match(
  /static uint32_t ws_osc_state_expire\([^)]*\)\n\{([\s\S]*?)\n\}/,
)?.[1] || '';
assert.ok(
  expireBody.includes('s_ws_active_until_us > 0') &&
    !expireBody.includes('s_ws_osc_streaming &&'),
  'inactive parameter polling leases must expire even when address streaming is false',
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
  /cloud_mqtt_note_realtime_control\(frame, frame_len\)/,
  'MQTT parameter reads and direct WSS reads must share one response lease policy',
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
for (const token of [
  'esp_websocket_client_init',
  'esp_websocket_client_start',
  'esp_websocket_client_send_bin',
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
  /static void sender_task\([\s\S]*uxQueueMessagesWaiting\(s_queue\) == 0[\s\S]*ulTaskNotifyTake\(pdTRUE, portMAX_DELAY\)[\s\S]*active = s_active[\s\S]*should_run = [\s\S]*s_wifi_ready;[\s\S]*esp_websocket_client_start[\s\S]*esp_websocket_client_stop[\s\S]*if \(!active\)[\s\S]*xQueueReceive\(s_queue, &chunk, 0\)/,
  'the worker must preconnect on STA readiness and gate only cloud UART data on the active lease',
);
const senderTaskBody = uplink.match(
  /static void sender_task\(void \*arg\)\n\{([\s\S]*?)\n\}/,
)?.[1] || '';
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
  uplinkHeader.includes('cloud_ws_uplink_set_active(bool active, uint32_t lease_generation)'),
  'uplink activation API must carry the lease generation',
);
assert.ok(
  leaseHeader.includes('cloud_ws_lease_gate_apply') &&
    uplink.includes('cloud_ws_lease_gate_apply(&s_lease_gate, lease_generation, active)'),
  'uplink desired state must reject stale lease updates through the tested gate',
);
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
  /if \(xQueueSend\(s_queue, &frame, 0\) != pdTRUE\)[\s\S]*xQueueReceive\(s_queue, &dropped, 0\)/,
  'transient disconnects must retain newest data with bounded oldest-frame eviction',
);
assert.ok(
  uplink.includes('#define CLOUD_WS_UPLINK_QUEUE_DEPTH 128U'),
  'cloud binary uplink queue must absorb mobile-network jitter without blocking UART',
);
assert.ok(
  uplink.includes('CLOUD_WAVEFORM_MAX_RAW_SIZE'),
  'cloud worker must drain a bounded 32768-byte raw aggregate',
);
assert.match(
  uplink,
  /s_raw_aggregate\s*=\s*heap_caps_calloc\([\s\S]*MALLOC_CAP_SPIRAM[\s\S]*if \(s_raw_aggregate == NULL\)[\s\S]*heap_caps_calloc\([\s\S]*MALLOC_CAP_INTERNAL/,
  'raw aggregation buffer must prefer PSRAM and retain an internal-RAM fallback',
);
assert.match(
  uplink,
  /s_wire_aggregate\s*=\s*heap_caps_calloc\([\s\S]*MALLOC_CAP_SPIRAM[\s\S]*if \(s_wire_aggregate == NULL\)[\s\S]*heap_caps_calloc\([\s\S]*MALLOC_CAP_INTERNAL/,
  'wire envelope buffer must prefer PSRAM and retain an internal-RAM fallback',
);
assert.match(
  uplink,
  /s_compressor_workspace\s*=\s*heap_caps_calloc\([\s\S]*MALLOC_CAP_SPIRAM[\s\S]*if \(s_compressor_workspace == NULL\)[\s\S]*heap_caps_calloc\([\s\S]*MALLOC_CAP_INTERNAL/,
  'Miniz compressor workspace must prefer PSRAM and retain an internal-RAM fallback',
);
assert.match(
  uplink,
  /cloud_waveform_encoder_init\(\s*&s_waveform_encoder,[\s\S]*s_compressor_workspace/,
  'uplink must bind the reusable Miniz workspace before advertising capability',
);
assert.match(
  senderTaskBody,
  /cloud_ws_uplink_frame_t next[\s\S]*xQueuePeek\(s_queue, &next, 0\)[\s\S]*raw_len \+ next\.len <= CLOUD_WAVEFORM_MAX_RAW_SIZE[\s\S]*xQueueReceive\(s_queue, &next, 0\)[\s\S]*memcpy\(s_raw_aggregate \+ raw_len/,
  'cloud uplink worker must coalesce only an existing backlog without blocking UART flow',
);
assert.doesNotMatch(
  senderTaskBody,
  /xQueueReceive\(s_queue, &chunk, 0\)[\s\S]{0,500}vTaskDelay[\s\S]{0,500}xQueuePeek/,
  'waveform aggregation must not add a coalescing wait',
);
assert.match(
  senderTaskBody,
  /cloud_ws_compression_take_offer[\s\S]*esp_websocket_client_send_bin\([\s\S]*CLOUD_WS_CAPABILITY/,
  'only the sender task may transmit the capability offer',
);
const eventHandlerBody = uplink.match(
  /static void websocket_event_handler\([^]*?\n\{([\s\S]*?)\n\}/,
)?.[1] || '';
assert.ok(
  !eventHandlerBody.includes('esp_websocket_client_send_bin'),
  'websocket event callback must never send or compress waveform data',
);
assert.match(
  senderTaskBody,
  /if \(!s_connected \|\| s_client == NULL\)[\s\S]*fallback_frame\(s_raw_aggregate, raw_len, source_frames\)/,
  'a disconnected WSS worker must drain queued responses through MQTT fallback',
);
assert.match(
  senderTaskBody,
  /sent != \(int\)send_len[\s\S]*send_failures[\s\S]*fallback_frame\(s_raw_aggregate, raw_len, source_frames\)/,
  'failed WSS sends must retry the complete source frame through MQTT fallback',
);
assert.match(
  uplink,
  /fallback_frame[\s\S]*queued_fallback_frames/,
  'successful queued fallback must account for every source frame',
);
assert.match(
  uplink,
  /xTaskCreate\(sender_task, "cloud_ws_tx", 8192/,
  'cloud uplink sender stack must remain bounded because aggregation storage lives on the heap',
);
assert.match(
  uplink,
  /\.buffer_size\s*=\s*CLOUD_WS_UPLINK_WS_BUFFER_SIZE/,
  'websocket receive/reassembly buffer must remain independently bounded',
);
assert.match(
  mainSource,
  /cloud_ws_uplink_config_t[\s\S]*CONFIG_CLOUD_WS_UPLINK_URI[\s\S]*s_cloud_device_id[\s\S]*cloud_ws_uplink_init/,
  'application startup must initialize the binary WebSocket uplink with URI and device identity',
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
  /\.fallback = cloud_mqtt_publish_ws_fallback[\s\S]*\.fallback_ctx = NULL/,
  'binary uplink failures must fall back to the existing MQTT transport',
);

console.log('cloud osc transport regression passed');
