# Cloud Waveform Duplex Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the browser's exact UART waveform bytes while reducing ESP32-to-cloud wire traffic enough that heartbeat ACKs stay safely below the motor's three-second watchdog.

**Architecture:** The ESP32 initiates per-connection capability negotiation with `WDC1`, drains currently queued waveform chunks into a bounded 32,768-byte aggregate, and sends a `WDZ1` raw or Miniz level-1 envelope only after the server acknowledges capability. The cloud validates and decompresses each negotiated envelope before the existing browser fan-out, while legacy firmware, raw browser controls, MQTT fallback, and the local AP path remain byte-for-byte compatible.

**Tech Stack:** Python 3.12, `zlib`, Flask/Waitress, `websockets`, ESP-IDF 6.0, ESP32-S3, ESP ROM Miniz API, C/FreeRTOS, PSRAM, Python and host-C regressions, Playwright, esptool.

## Global Constraints

- Firmware/cloud root: `/mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723` on branch `fix/cloud-osc-reliability-fw-20260724`.
- Web root: `/mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723` on branch `fix/cloud-osc-reliability-web-20260724`.
- Envelope magic is `WDZ1`; codec `0` is raw; codec `1` is zlib; reserved bytes are zero; length and CRC32 are network-byte-order; maximum uncompressed aggregate is exactly `32768` bytes.
- New firmware sends `WDC1`; the server never sends `WDC1` unsolicited; firmware consumes a complete reply and never forwards it to UART.
- Use ESP ROM `miniz.h`, `mz_compress2(..., MZ_BEST_SPEED)`, and `mz_crc32(MZ_CRC32_INIT, ...)`; add no third-party compression component.
- Preserve the existing 128-frame bounded PSRAM source queue, oldest-frame overload eviction, raw downlink controls, automatic reconnect, and bounded MQTT failure fallback.
- Aggregation drains only chunks already queued and adds no coalescing delay.
- Preserve local AP WebSocket bytes and all verified local parameter/address oscilloscope behavior.
- Do not modify or restart Nginx, authentication, PostgreSQL 17, Mosquitto, bootloader, partition table, or SPIFFS.
- Back up every remote cloud file before replacement; rebuild and restart only the Wireless Debug `cloud` service.
- Flash only `build/uart_ble_wifi.bin` at `0x10000`, and only after explicit download-mode confirmation.
- Archive the tested app, flash metadata, source revisions, and SHA-256 checksums before flashing.
- Do not print or commit credentials, UART payloads, database URLs, session secrets, or private keys.
- Do not push, merge, delete branches, or clean either worktree.

## File Structure

- `tools/remote_mqtt_python/waveform_codec.py`: cloud envelope contract, bounded decoder, reasoned failures, per-process lock-protected codec metrics.
- `scripts/cloud_waveform_codec_regression.py`: Python codec, negotiation, rejection, telemetry, and deterministic fixture regression.
- `fixtures/cloud-waveform-codec-v1.json`: deterministic zero-heavy, mixed, and incompressible raw/envelope fixtures.
- `tools/remote_mqtt_python/app.py`: per-uplink negotiation state, decode-before-fan-out integration, and `/health` exposure.
- `tools/remote_mqtt_python/Dockerfile`: copy the new codec module into the cloud image.
- `tools/remote_mqtt_python/docker-compose.yml`: raise only the cloud WebSocket message bound to `65536` bytes.
- `scripts/cloud_ws_waveform_negotiation_regression.py`: server integration and backward-compatibility contracts.
- `main/cloud_waveform_codec.h` / `.c`: firmware `WDZ1` encoder with Miniz level 1 and raw-envelope fallback.
- `main/cloud_ws_compression_state.h`: small testable per-connection offer/reply state machine.
- `scripts/host_include/miniz.h`: host-test compatibility shim mapping ESP Miniz names to system zlib.
- `scripts/cloud_waveform_codec_regression.c`: host-C envelope and state-machine regression.
- `scripts/cloud_waveform_cross_language_regression.py`: C-produced envelope to Python-decoder byte-equality fixture check.
- `main/cloud_ws_uplink.h` / `.c`: PSRAM aggregate buffers, sender-owned offer and compression, reply consumption, schema-6 counters.
- `main/cloud_mqtt.c` and `main/web_api.c`: publish the same schema-6 telemetry through cloud and local status endpoints.
- `scripts/cloud_osc_hardware_acceptance.py` and `_regression.py`: enforce heartbeat, compression, queue, drop, timing, and byte-accounting budgets.
- Web `scripts/cloud-osc-compression-ui-acceptance.mjs`: five-minute parameter soak and 60-second address-cache/browser acceptance.

---

### Task 1: Cloud Codec Contract and Deterministic Fixtures

**Repository:** Firmware/cloud

**Files:**
- Create: `tools/remote_mqtt_python/waveform_codec.py`
- Create: `scripts/cloud_waveform_codec_regression.py`
- Create: `fixtures/cloud-waveform-codec-v1.json`

**Interfaces:**
- Produces: `CAPABILITY = b"WDC1"`, `MAGIC = b"WDZ1"`, `MAX_RAW_BYTES = 32768`.
- Produces: `encode_envelope(raw: bytes, force_raw: bool = False) -> bytes` for fixtures/tests only.
- Produces: `WaveformDecodeError.reason: str` and `WaveformDecoder.decode(message: bytes, compression_active: bool) -> bytes`.
- Produces: `WaveformDecoder.note_activation()` and `WaveformDecoder.snapshot() -> dict[str, object]`.

- [ ] **Step 1: Write the failing Python codec regression**

Create `scripts/cloud_waveform_codec_regression.py` with table-driven checks that import the interfaces above and assert:

```python
assert decoder.decode(b"legacy-uart", False) == b"legacy-uart"
assert decoder.decode(encode_envelope(zero_heavy), True) == zero_heavy
assert decoder.decode(encode_envelope(mixed, force_raw=True), True) == mixed
assert decoder.snapshot()["legacy_raw_messages"] == 1
assert decoder.snapshot()["compressed_messages"] == 1
assert decoder.snapshot()["raw_envelope_messages"] == 1

bad_cases = {
    "short_header": b"WDZ1",
    "bad_magic": replace_header(valid_raw, magic=b"BAD1"),
    "reserved_nonzero": replace_header(valid_raw, reserved=b"\x00\x01\x00"),
    "unsupported_codec": replace_header(valid_raw, codec=2),
    "invalid_length": replace_header(valid_raw, raw_len=32769),
    "raw_size_mismatch": valid_raw[:-1],
    "compressed_stream": valid_zlib[:-1],
    "trailing_data": valid_zlib + b"x",
    "length_mismatch": replace_header(valid_zlib, raw_len=len(zero_heavy) - 1),
    "crc_mismatch": replace_header(valid_zlib, crc32=0),
}
for reason, envelope in bad_cases.items():
    with expect_decode_error(reason):
        decoder.decode(envelope, True)
snapshot = decoder.snapshot()
assert snapshot["decode_failures"] == {reason: 1 for reason in bad_cases}
assert snapshot["wire_bytes"] > 0
assert snapshot["decoded_raw_bytes"] == len(b"legacy-uart") + len(zero_heavy) + len(mixed)
```

The helper `replace_header()` must unpack/repack `struct.Struct("!4sB3sII")`; `expect_decode_error()` must assert the exact `.reason`, not only the exception type. Use deterministic payloads:

```python
zero_heavy = bytes(32768)
mixed = bytes((index * 37 + index // 11) & 0xFF for index in range(8192))
rng = random.Random(0x57445A31)
incompressible = rng.randbytes(8192)
```

- [ ] **Step 2: Run the regression and verify RED**

```bash
python3 scripts/cloud_waveform_codec_regression.py
```

Expected: FAIL with `ModuleNotFoundError` for `waveform_codec`.

- [ ] **Step 3: Implement the bounded decoder and metrics**

Implement `waveform_codec.py` around this exact header and public result contract:

```python
CAPABILITY = b"WDC1"
MAGIC = b"WDZ1"
CODEC_RAW = 0
CODEC_ZLIB = 1
MAX_RAW_BYTES = 32768
HEADER = struct.Struct("!4sB3sII")

class WaveformDecodeError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason

class WaveformDecoder:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._wire_bytes = 0
        self._decoded_raw_bytes = 0
        self._activations = 0
        self._compressed_messages = 0
        self._raw_envelope_messages = 0
        self._legacy_raw_messages = 0
        self._decode_failures: Counter[str] = Counter()
        self._decode_total_us = 0
        self._decode_max_us = 0

    def decode(self, message: bytes, compression_active: bool) -> bytes:
        data = bytes(message)
        started_ns = time.perf_counter_ns()
        try:
            raw, kind = _decode(data, compression_active)
        except WaveformDecodeError as exc:
            self._record_failure(exc.reason, data, started_ns)
            raise
        self._record_success(kind, data, raw, started_ns)
        return raw
```

For codec `1`, use `zlib.decompressobj()` with `decompress(encoded, raw_len + 1)`, require `eof`, reject `unconsumed_tail`, reject `unused_data` as `trailing_data`, then require exact length and `zlib.crc32(raw) & 0xffffffff`. Do not use unbounded `zlib.decompress()`.

- [ ] **Step 4: Generate and verify deterministic fixtures**

Add fixture generation to the regression so `--write-fixtures` writes JSON objects containing `name`, `raw_len`, `raw_sha256`, `raw_b64`, `raw_envelope_b64`, and `zlib_envelope_b64`. Run:

```bash
python3 scripts/cloud_waveform_codec_regression.py --write-fixtures
python3 scripts/cloud_waveform_codec_regression.py
python3 scripts/cloud_waveform_codec_regression.py --check-fixtures
```

Expected: all codec/rejection assertions pass and `--check-fixtures` reports the committed JSON is byte-for-byte identical to regenerated output.

- [ ] **Step 5: Commit the cloud codec**

```bash
git add tools/remote_mqtt_python/waveform_codec.py scripts/cloud_waveform_codec_regression.py fixtures/cloud-waveform-codec-v1.json
git commit -m "feat: add cloud waveform envelope codec"
```

---

### Task 2: Server-Initiated Decode After Firmware Offer

**Repository:** Firmware/cloud

**Files:**
- Modify: `tools/remote_mqtt_python/waveform_codec.py`
- Modify: `tools/remote_mqtt_python/app.py`
- Modify: `tools/remote_mqtt_python/Dockerfile`
- Modify: `tools/remote_mqtt_python/docker-compose.yml`
- Create: `scripts/cloud_ws_waveform_negotiation_regression.py`

**Interfaces:**
- Consumes: `CAPABILITY`, `WaveformDecoder.decode()`, `note_activation()`, and `snapshot()` from Task 1.
- Produces: `UplinkWaveformSession.is_offer(data)`, `mark_reply_sent()`, and `decode(data)` so activation cannot precede a successful reply.
- Produces: per-connection `compression_active` state in `cloud_ws_uplink_handler`; decoded raw bytes continue through `broadcast_remote_ws_bytes(device_id, payload)`.
- Produces: `/health.waveform_codec` containing the Task 1 snapshot.

- [ ] **Step 1: Write failing negotiation and source-contract tests**

Create `scripts/cloud_ws_waveform_negotiation_regression.py`. Test a fake decoder/router sequence and assert the app source contains the same ordering:

```python
raw = b"waveform-fixture"
valid_envelope = encode_envelope(raw)
session = UplinkWaveformSession(WaveformDecoder())
assert session.decode(b"legacy") == b"legacy"
assert session.compression_active is False
assert session.is_offer(b"WDC1") is True
assert session.is_offer(b"WDC1x") is False
session.mark_reply_sent()
assert session.compression_active is True
assert session.decode(valid_envelope) == raw

source = APP_PATH.read_text(encoding="utf-8")
handler = source[source.index("def cloud_ws_uplink_handler"):source.index("def cloud_ws_handler")]
assert handler.index("session.is_offer(data)") < handler.index("session.decode(data)")
assert handler.index("cloud_ws_downlinks.send") < handler.index("session.mark_reply_sent")
assert "broadcast_remote_ws_bytes(device_id, decoded)" in handler
assert "broadcast_remote_ws_bytes(device_id, data)" not in handler
assert "'waveform_codec': waveform_decoder.snapshot()" in source
```

Also assert `Dockerfile` copies `waveform_codec.py` and Compose defaults `CLOUD_WS_MAX_MESSAGE_BYTES` to `65536` without changing any Postgres, Mosquitto, port, volume, or browser-pacing line.

- [ ] **Step 2: Run the server regression and verify RED**

```bash
python3 scripts/cloud_ws_waveform_negotiation_regression.py
```

Expected: FAIL because the handler still forwards every non-empty device binary message directly.

- [ ] **Step 3: Integrate negotiation and decode-before-fan-out**

Add this session wrapper to `waveform_codec.py`:

```python
class UplinkWaveformSession:
    def __init__(self, decoder: WaveformDecoder) -> None:
        self._decoder = decoder
        self.compression_active = False

    def is_offer(self, data: bytes) -> bool:
        return bytes(data) == CAPABILITY

    def mark_reply_sent(self) -> None:
        if not self.compression_active:
            self.compression_active = True
            self._decoder.note_activation()

    def decode(self, data: bytes) -> bytes:
        return self._decoder.decode(data, self.compression_active)
```

Instantiate one process-wide `WaveformDecoder`. In `cloud_ws_uplink_handler`, create one `UplinkWaveformSession` local to that connection:

```python
session = UplinkWaveformSession(waveform_decoder)
while True:
    message = connection.recv()
    if isinstance(message, str):
        app.logger.warning('ignoring text websocket uplink frame for %s', device_id)
        continue
    data = bytes(message or b'')
    if not data:
        continue
    if session.is_offer(data):
        sent, reason = cloud_ws_downlinks.send(device_id, CAPABILITY)
        if sent:
            session.mark_reply_sent()
        else:
            app.logger.warning('waveform capability reply failed for %s: %s', device_id, reason)
        continue
    try:
        decoded = session.decode(data)
    except WaveformDecodeError as exc:
        app.logger.warning('waveform envelope rejected for %s: %s', device_id, exc.reason)
        continue
    broadcast_remote_ws_bytes(device_id, decoded)
```

The exact four-byte offer is consumed and never reaches browsers. No reply is sent before an offer. A failed reply leaves `compression_active` false.

- [ ] **Step 4: Expose metrics and raise only the message bound**

Add `'waveform_codec': waveform_decoder.snapshot()` to `/health`; add `waveform_codec.py` to the Docker `COPY`; change the `app.py` and Compose `CLOUD_WS_MAX_MESSAGE_BYTES` defaults from `16384` to `65536`. Do not edit `.env`, `requirements.txt`, `ws_fanout.py`, or service dependencies.

- [ ] **Step 5: Verify cloud unit and neighboring regressions**

```bash
python3 scripts/cloud_waveform_codec_regression.py --check-fixtures
python3 scripts/cloud_ws_waveform_negotiation_regression.py
python3 scripts/cloud_ws_downlink_regression.py
python3 scripts/cloud_ws_fanout_regression.py
python3 scripts/cloud_ws_keepalive_regression.py
python3 scripts/cloud_session_auth_regression.py
```

Expected: every command exits 0; raw downlink serialization and browser fan-out behavior are unchanged.

- [ ] **Step 6: Commit the server integration**

```bash
git add tools/remote_mqtt_python/waveform_codec.py tools/remote_mqtt_python/app.py tools/remote_mqtt_python/Dockerfile tools/remote_mqtt_python/docker-compose.yml scripts/cloud_ws_waveform_negotiation_regression.py
git commit -m "feat: decode negotiated cloud waveforms"
```

---

### Task 3: Server-First Backup, Deployment, and Legacy Verification

**Repository:** Firmware/cloud locally; `/home/ubuntu/wireless-debug-cloud` remotely

**Files:**
- Back up remote: `tools/remote_mqtt_python/app.py`, `Dockerfile`, `docker-compose.yml`
- Deploy remote: those files plus new `waveform_codec.py`
- Backup directory: `/home/ubuntu/wireless-debug-cloud/backups/waveform-codec-before-20260727/`

**Interfaces:**
- Consumes: tested server files from Task 2.
- Produces: codec-aware server that remains silent toward current raw firmware until it receives `WDC1`.

- [ ] **Step 1: Capture pre-deployment state and create an immutable backup**

```bash
ssh -o BatchMode=yes tencent-wireless 'set -e
cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python
backup=/home/ubuntu/wireless-debug-cloud/backups/waveform-codec-before-20260727
test ! -e "$backup"
mkdir -p "$backup"
cp -a app.py Dockerfile docker-compose.yml "$backup"/
sha256sum app.py Dockerfile docker-compose.yml > "$backup/SHA256SUMS"
printf "%s\n" "$backup"
'
```

Expected: the exact backup path is printed; if it already exists, stop and inspect it instead of overwriting it.

- [ ] **Step 2: Stage and hash the four cloud files**

```bash
tar -C tools/remote_mqtt_python -cf - app.py Dockerfile docker-compose.yml waveform_codec.py | ssh -o BatchMode=yes tencent-wireless 'rm -rf /tmp/wd-waveform-codec && mkdir -p /tmp/wd-waveform-codec && tar -C /tmp/wd-waveform-codec -xf - && sha256sum /tmp/wd-waveform-codec/*'
```

Compare those hashes with:

```bash
sha256sum tools/remote_mqtt_python/app.py tools/remote_mqtt_python/Dockerfile tools/remote_mqtt_python/docker-compose.yml tools/remote_mqtt_python/waveform_codec.py
```

Expected: all four local/staged hashes match.

- [ ] **Step 3: Replace only cloud-service files and rebuild only `cloud`**

```bash
ssh -o BatchMode=yes tencent-wireless 'set -e
cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python
install -m 0644 /tmp/wd-waveform-codec/app.py app.py
install -m 0644 /tmp/wd-waveform-codec/Dockerfile Dockerfile
install -m 0644 /tmp/wd-waveform-codec/docker-compose.yml docker-compose.yml
install -m 0644 /tmp/wd-waveform-codec/waveform_codec.py waveform_codec.py
sudo docker compose up -d --build --no-deps cloud
sudo docker compose ps cloud
'
```

Expected: only `remote_mqtt_python-cloud-1` is recreated; PostgreSQL 17 and Mosquitto creation timestamps do not change.

- [ ] **Step 4: Verify health, logs, and current raw-firmware compatibility**

Before flashing firmware, run a 20-second cloud address test and capture `/health` before/after:

```bash
ssh -o BatchMode=yes tencent-wireless 'set -e
cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python
curl -fsS http://127.0.0.1:18088/health
sudo docker compose logs --tail=120 cloud
sudo docker compose exec -T cloud python - --mode cloud --device-id wd-ac276eab7c9c --duration 20 --no-inject-fallback --min-bytes-per-second 1 --max-p95-ms 10000 --max-gap-ms 10000 --cloud-http http://127.0.0.1:18088 --cloud-ws ws://127.0.0.1:18089
' < scripts/cloud_osc_hardware_acceptance.py
```

Expected for schema-5 firmware: no server-sent `WDC1`, `waveform_codec.activations == 0`, `legacy_raw_messages` increases, and the existing raw stream still reaches the browser. This is a compatibility check, not a throughput pass.

---

### Task 4: Firmware Envelope Encoder and Host-C Contract

**Repository:** Firmware/cloud

**Files:**
- Create: `main/cloud_waveform_codec.h`
- Create: `main/cloud_waveform_codec.c`
- Create: `scripts/host_include/miniz.h`
- Create: `scripts/cloud_waveform_codec_regression.c`
- Create: `scripts/cloud_waveform_cross_language_regression.py`
- Modify: `main/CMakeLists.txt`

**Interfaces:**
- Produces: `cloud_waveform_encode(raw, raw_len, wire, wire_capacity, wire_len, result) -> bool`.
- Produces: `cloud_waveform_encode_result_t { codec, compression_failed, raw_len, wire_len }`.
- Consumes: Task 1 fixture JSON and cloud `WaveformDecoder`.

- [ ] **Step 1: Write the failing host-C and cross-language regressions**

The C regression must cover zero length rejection, `32769` rejection, insufficient output capacity, codec-1 selection for zeros, codec-0 selection for incompressible bytes, network byte order, zero reserved bytes, CRC32, and exact zlib restoration. The cross-language script must compile/run the C fixture emitter and assert:

```python
for fixture in fixtures:
    raw = base64.b64decode(fixture["raw_b64"])
    wire = subprocess.check_output([str(tool), fixture["name"]], input=raw)
    decoded = WaveformDecoder().decode(wire, True)
    assert decoded == raw
    assert hashlib.sha256(decoded).hexdigest() == fixture["raw_sha256"]
```

- [ ] **Step 2: Compile and verify RED**

```bash
cc -std=c11 -Wall -Wextra -Werror -Iscripts/host_include -Imain main/cloud_waveform_codec.c scripts/cloud_waveform_codec_regression.c -lz -o /tmp/cloud_waveform_codec_regression
```

Expected: FAIL because the firmware codec files do not exist.

- [ ] **Step 3: Implement the fixed envelope API**

Use this public contract in `main/cloud_waveform_codec.h`:

```c
#define CLOUD_WAVEFORM_MAGIC "WDZ1"
#define CLOUD_WAVEFORM_HEADER_SIZE 16U
#define CLOUD_WAVEFORM_MAX_RAW_SIZE 32768U
#define CLOUD_WAVEFORM_MAX_WIRE_SIZE (CLOUD_WAVEFORM_HEADER_SIZE + CLOUD_WAVEFORM_MAX_RAW_SIZE)

typedef enum {
    CLOUD_WAVEFORM_CODEC_RAW = 0,
    CLOUD_WAVEFORM_CODEC_ZLIB = 1,
} cloud_waveform_codec_t;

typedef struct {
    cloud_waveform_codec_t codec;
    bool compression_failed;
    size_t raw_len;
    size_t wire_len;
} cloud_waveform_encode_result_t;

bool cloud_waveform_encode(const uint8_t *raw, size_t raw_len,
                           uint8_t *wire, size_t wire_capacity,
                           size_t *wire_len,
                           cloud_waveform_encode_result_t *result);
```

Write header fields byte-by-byte in network order. Call `mz_compress2(wire + 16, &compressed_len, raw, raw_len, MZ_BEST_SPEED)` with destination capacity `raw_len`; select codec `1` only when the call returns `MZ_OK` and `compressed_len < raw_len`. Otherwise copy raw bytes after the header, select codec `0`, and set `compression_failed` only when Miniz returned neither `MZ_OK` nor the expected no-gain/buffer result.

- [ ] **Step 4: Add the host Miniz shim and ESP component dependency**

Create `scripts/host_include/miniz.h`:

```c
#ifndef HOST_MINIZ_H
#define HOST_MINIZ_H
#include <zlib.h>
typedef uLong mz_ulong;
#define MZ_OK Z_OK
#define MZ_BUF_ERROR Z_BUF_ERROR
#define MZ_BEST_SPEED Z_BEST_SPEED
#define MZ_CRC32_INIT 0U
#define mz_compress2 compress2
#define mz_crc32 crc32
#endif
```

Add `cloud_waveform_codec.c` to `SRCS` and `esp_rom` to `REQUIRES` in `main/CMakeLists.txt`.

- [ ] **Step 5: Verify host C and cross-language GREEN**

```bash
cc -std=c11 -Wall -Wextra -Werror -Iscripts/host_include -Imain main/cloud_waveform_codec.c scripts/cloud_waveform_codec_regression.c -lz -o /tmp/cloud_waveform_codec_regression
/tmp/cloud_waveform_codec_regression
python3 scripts/cloud_waveform_cross_language_regression.py
python3 scripts/cloud_waveform_codec_regression.py --check-fixtures
```

Expected: C contract passes; every C envelope decodes to bytes and SHA-256 identical to its Python fixture raw bytes.

- [ ] **Step 6: Commit the firmware codec**

```bash
git add main/cloud_waveform_codec.h main/cloud_waveform_codec.c main/CMakeLists.txt scripts/host_include/miniz.h scripts/cloud_waveform_codec_regression.c scripts/cloud_waveform_cross_language_regression.py
git commit -m "feat: encode lossless waveform envelopes"
```

---

### Task 5: Firmware Negotiation, Aggregation, and Fallback Preservation

**Repository:** Firmware/cloud

**Files:**
- Create: `main/cloud_ws_compression_state.h`
- Create: `scripts/cloud_ws_compression_state_regression.c`
- Modify: `main/cloud_ws_uplink.c`
- Modify: `main/cloud_ws_uplink.h`
- Modify: `scripts/cloud_osc_transport_regression.mjs`

**Interfaces:**
- Consumes: Task 4 `cloud_waveform_encode()`.
- Produces: sender-task-only `WDC1` offer, exact reply consumption, reconnect reset, 32,768-byte no-wait aggregate, raw-envelope fallback.
- Preserves: `cloud_ws_uplink_send()` queue API and MQTT `fallback(raw, raw_len, ctx)` bytes.
- Defines: `CLOUD_WS_CAPABILITY "WDC1"` and `CLOUD_WS_CAPABILITY_LEN 4U`; every state transition is protected by `s_state_lock` in `cloud_ws_uplink.c`.

- [ ] **Step 1: Write the failing connection-state regression**

Create a host-C test for this state sequence:

```c
cloud_ws_compression_state_t state = {0};
cloud_ws_compression_on_connected(&state, true);
assert(cloud_ws_compression_take_offer(&state));
assert(!cloud_ws_compression_take_offer(&state));
assert(!cloud_ws_compression_accept_reply(&state, (const uint8_t *)"WDC", 3));
assert(!cloud_ws_compression_accept_reply(&state, (const uint8_t *)"WDC2", 4));
assert(cloud_ws_compression_accept_reply(&state, (const uint8_t *)"WDC1", 4));
assert(state.active);
cloud_ws_compression_on_disconnected(&state);
assert(!state.active && !state.offer_pending && !state.offer_sent);
cloud_ws_compression_on_connected(&state, false);
assert(!cloud_ws_compression_take_offer(&state));
```

Extend `scripts/cloud_osc_transport_regression.mjs` with source contracts requiring the `32768` raw aggregate, PSRAM allocation before internal-RAM fallback for both buffers, capability send only inside `sender_task`, reply acceptance before `s_config.on_downlink`, and no delay between the first queue receive and the adjacent queue-drain loop.

```js
assert.match(uplink, /CLOUD_WAVEFORM_MAX_RAW_SIZE/);
assert.match(uplink, /MALLOC_CAP_SPIRAM[\s\S]*MALLOC_CAP_INTERNAL/);
const sender = uplink.slice(uplink.indexOf('static void sender_task'), uplink.indexOf('static void websocket_event_handler'));
assert.match(sender, /esp_websocket_client_send_bin\([\s\S]*CLOUD_WS_CAPABILITY/);
const events = uplink.slice(uplink.indexOf('static void websocket_event_handler'));
assert.doesNotMatch(events, /send_bin\([\s\S]*CLOUD_WS_CAPABILITY/);
assert.ok(uplink.indexOf('cloud_ws_compression_accept_reply') < uplink.indexOf('s_config.on_downlink'));
assert.doesNotMatch(sender, /xQueueReceive\([\s\S]{0,500}vTaskDelay[\s\S]{0,500}xQueuePeek/);
```

- [ ] **Step 2: Compile and verify RED**

```bash
cc -std=c11 -Wall -Wextra -Werror -Imain scripts/cloud_ws_compression_state_regression.c -o /tmp/cloud_ws_compression_state_regression
```

Expected: FAIL because `cloud_ws_compression_state.h` is missing.

- [ ] **Step 3: Implement the pure state machine**

`cloud_ws_compression_state.h` must define only the state and inline transitions; it must not call WebSocket, FreeRTOS, UART, or compression APIs. `take_offer()` marks `offer_sent=true`; `accept_reply()` activates only when connected, capable, offer sent, inactive, and the complete payload is exactly four bytes `WDC1`.

`cloud_ws_compression_offer_failed()` clears `offer_sent` without re-arming `offer_pending`, so one failed offer cannot activate compression and does not create a retry loop on the same connection.

- [ ] **Step 4: Add PSRAM-first raw and wire buffers**

Replace the 2,048-byte aggregate object with two separately allocated buffers sized `CLOUD_WAVEFORM_MAX_RAW_SIZE` and `CLOUD_WAVEFORM_MAX_WIRE_SIZE`. Allocate each with `MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT`, fall back to internal RAM, and leave compression capability false if the wire buffer cannot be allocated while retaining legacy raw upload through the raw buffer. Preserve the existing 128-entry queue and 512-byte source chunks.

- [ ] **Step 5: Send one offer from the sender task and consume its reply**

On `WEBSOCKET_EVENT_CONNECTED`, reset/initialize state and notify `s_sender_task`; do not send from the callback. At the start of each sender loop:

```c
if (s_connected && cloud_ws_compression_take_offer(&s_compression_state)) {
    int offered = esp_websocket_client_send_bin(
        s_client, CLOUD_WS_CAPABILITY, CLOUD_WS_CAPABILITY_LEN,
        pdMS_TO_TICKS(CLOUD_WS_UPLINK_SEND_TIMEOUT_MS));
    if (offered != CLOUD_WS_CAPABILITY_LEN) {
        cloud_ws_compression_offer_failed(&s_compression_state);
    }
}
```

After downlink reassembly completes, call `cloud_ws_compression_accept_reply()` before `s_config.on_downlink`; return immediately when it accepts the marker. Every disconnect/error/closed event resets compression state.

- [ ] **Step 6: Aggregate without waiting and preserve fallback ownership**

After receiving one queue chunk, repeatedly `xQueuePeek`/`xQueueReceive` only while chunks are already available and fit within `32768`. If negotiated, encode and send the envelope; otherwise send the raw aggregate. On disconnect or send failure, pass the original raw aggregate to the existing 512-byte-splitting MQTT fallback exactly once. Never pass `WDZ1` or `WDC1` bytes to MQTT or UART.

- [ ] **Step 7: Verify state, codec, lease, downlink, and fallback regressions**

```bash
cc -std=c11 -Wall -Wextra -Werror -Imain scripts/cloud_ws_compression_state_regression.c -o /tmp/cloud_ws_compression_state_regression
/tmp/cloud_ws_compression_state_regression
python3 scripts/cloud_waveform_cross_language_regression.py
cc -std=c11 -Wall -Wextra -Werror -Imain scripts/cloud_ws_downlink_reassembly_regression.c -o /tmp/cloud_ws_downlink_reassembly_regression
/tmp/cloud_ws_downlink_reassembly_regression
cc -std=c11 -Wall -Wextra -Werror -Imain scripts/cloud_ws_lease_regression.c -o /tmp/cloud_ws_lease_regression
/tmp/cloud_ws_lease_regression
node scripts/cloud_osc_transport_regression.mjs
```

Expected: all commands exit 0; state resets on reconnect, the marker never reaches UART, and raw fallback bytes remain unchanged.

- [ ] **Step 8: Commit transport integration**

```bash
git add main/cloud_ws_compression_state.h main/cloud_ws_uplink.c main/cloud_ws_uplink.h scripts/cloud_ws_compression_state_regression.c scripts/cloud_osc_transport_regression.mjs
git commit -m "feat: negotiate compressed waveform uplink"
```

---

### Task 6: Schema-6 Telemetry and Acceptance Instrumentation

**Repository:** Firmware/cloud

**Files:**
- Modify: `main/cloud_ws_uplink.h`
- Modify: `main/cloud_ws_uplink.c`
- Modify: `main/cloud_mqtt.c`
- Modify: `main/web_api.c`
- Modify: `scripts/cloud_osc_hardware_acceptance.py`
- Modify: `scripts/cloud_osc_hardware_acceptance_regression.py`

**Interfaces:**
- Produces firmware schema `6` fields: `compression_capable`, `compression_active`, `compression_calls`, `compressed_frames`, `raw_envelope_frames`, `compression_failures`, `raw_bytes`, `wire_bytes`, `compression_total_us`, `compression_max_us`.
- Consumes cloud `/health.waveform_codec` from Task 2.
- Produces heartbeat ACK latency, compression ratio, timing, drop, heap, and accounting verdicts.

- [ ] **Step 1: Extend the failing acceptance regression**

Change `ensure_current_firmware()` expectations from schema 5 to schema 6. Add before/after fixture values and assert deltas/verdicts for every schema-6 field plus cloud metrics:

```python
assert deltas["uplink_raw_bytes"] == 240000
assert deltas["uplink_wire_bytes"] == 12000
assert verdict["checks"]["compression_negotiated"] is True
assert verdict["checks"]["wire_ratio_below_20_percent"] is True
assert verdict["checks"]["compression_average_us"] is True
assert verdict["checks"]["compression_max_us"] is True
assert verdict["checks"]["cloud_decode_average_us"] is True
assert verdict["checks"]["heartbeat_p95_ms"] is True
assert verdict["checks"]["heartbeat_max_ms"] is True
assert verdict["checks"]["browser_pump_no_drop"] is True
assert verdict["checks"]["cloud_decode_no_failure"] is True
assert verdict["checks"]["internal_min_free_heap"] is True
```

Add explicit failing cases at ratios `0.20`, compression average `5001 us`, compression max `10001 us`, cloud average `1001 us`, heartbeat P95 `500.01 ms`, heartbeat max `2000 ms`, heap `8191`, and each nonzero drop/failure counter. Record cloud maximum decode time for diagnosis, but do not invent a pass/fail ceiling because the approved design sets only the cloud average budget.

- [ ] **Step 2: Run and verify RED**

```bash
python3 scripts/cloud_osc_hardware_acceptance_regression.py
```

Expected: FAIL because schema 6 fields and verdict parameters do not exist.

- [ ] **Step 3: Add lock-protected firmware counters**

Advance `CLOUD_WS_UPLINK_SCHEMA_VERSION` to `6U`. Time each active encode with `esp_timer_get_time()`. Count envelope messages, not source chunks, in `compressed_frames` and `raw_envelope_frames`; preserve source-chunk accounting in `queued_frames` and `sent_frames`. Count `raw_bytes` as original aggregate bytes and `wire_bytes` as physical waveform message bytes, excluding `WDC1`. Publish identical names through `cloud_mqtt.c` and `/api/device/status`; enlarge the fixed status buffer only as required by the added JSON.

- [ ] **Step 4: Capture heartbeat ACK latency and cloud health deltas**

In `run_stream()`, append each heartbeat send timestamp to a FIFO. In the receiver, scan the exact decoded byte stream for `HEARTBEAT_FRAME`, pair ACKs FIFO-order, and report `count`, `p95_ms`, and `max_ms`. Fetch `/health` before/after cloud runs and calculate codec deltas without credentials in logs. Add verdict limits:

```python
wire_ratio = uplink_wire_bytes / uplink_raw_bytes
compression_average_us = compression_total_us / max(1, compression_calls)
cloud_decode_average_us = decode_total_us / max(1, compressed_messages + raw_envelope_messages)
checks.update({
    "compression_negotiated": compression_capable and compression_active,
    "wire_ratio_below_20_percent": wire_ratio < 0.20,
    "compression_average_us": compression_average_us <= 5000,
    "compression_max_us": compression_max_us <= 10000,
    "cloud_decode_average_us": cloud_decode_average_us <= 1000,
    "heartbeat_p95_ms": heartbeat_p95_ms <= 500,
    "heartbeat_max_ms": heartbeat_max_ms < 2000,
    "internal_min_free_heap": internal_min_free_heap >= 8192,
})
```

Stable-path cloud runs additionally require zero UART overflow, queue full, overload eviction, raw send failure, browser-pump drop, decode failure, fallback failure, and unaccounted source chunk.

- [ ] **Step 5: Verify acceptance logic GREEN**

```bash
python3 scripts/cloud_osc_hardware_acceptance_regression.py
python3 scripts/cloud_waveform_codec_regression.py --check-fixtures
python3 scripts/cloud_ws_waveform_negotiation_regression.py
```

Expected: all positive fixtures pass and every boundary fixture fails for its named reason.

- [ ] **Step 6: Commit telemetry and harness changes**

```bash
git add main/cloud_ws_uplink.h main/cloud_ws_uplink.c main/cloud_mqtt.c main/web_api.c scripts/cloud_osc_hardware_acceptance.py scripts/cloud_osc_hardware_acceptance_regression.py
git commit -m "test: enforce waveform compression budgets"
```

---

### Task 7: Browser Soak Acceptance Script

**Repository:** Web

**Files:**
- Create: `scripts/cloud-osc-compression-ui-acceptance.mjs`

**Interfaces:**
- Consumes: authenticated remote page, `ParameterTable.xlsx`, existing UI controls.
- Produces: `/tmp/cloud-waveform-compression-ui.json` and `/tmp/cloud-waveform-compression-ui.png`.
- Supports: `TARGET_MODE=cloud|local`, `PARAM_DURATION_MS`, and `ADDRESS_DURATION_MS`, defaulting to cloud, `300000`, and `60000`.

- [ ] **Step 1: Create a failing dry-run selector contract**

The script must support `--dry-run` and statically require these workflows:

```js
assert.ok(existsSync(paramTable), `parameter table missing: ${paramTable}`);
const targetMode = process.env.TARGET_MODE || 'cloud';
const paramDurationMs = Number(process.env.PARAM_DURATION_MS || 300_000);
const addressDurationMs = Number(process.env.ADDRESS_DURATION_MS || 60_000);
await page.locator('input[type=file]').first().setInputFiles(paramTable);
await page.getByRole('button', { name: /参数示波器/ }).first().click();
await page.getByRole('button', { name: /开始/ }).first().click();
await sampleFor(page, paramDurationMs);
await page.getByRole('button', { name: /地址示波器/ }).first().click();
await configureAddressChannels(page, ['C52C', '0000', '0000', '0000']);
await sampleFor(page, addressDurationMs);
```

`sampleFor()` must poll once per second and record status text instead of sleeping once, so it proves the page remained `运行中` throughout.

- [ ] **Step 2: Implement metrics and strict assertions**

Parse parameter request/response/sample counters and address `缓存: Xs / Y MB`. Track received `/ws/device/` frame timestamps and bytes through Playwright's WebSocket event. Require:

```js
assert.equal(paramStoppedEarly, false);
assert.ok(paramRequests > 0 && paramResponses > 0 && paramSamples > 0);
assert.equal(addressStoppedEarly, false);
assert.ok(addressCacheSeconds >= 30);
assert.ok(addressCacheMegabytes > 0);
if (targetMode === 'cloud') {
  assert.ok(addressWsBytes >= 60_000 * addressDurationMs / 1000);
}
```

Write JSON evidence and a full-page screenshot. Require `CLOUD_HTTP_USER` and `CLOUD_HTTP_PASSWORD` only when `TARGET_MODE=cloud`; read them only from the environment and never print them.

- [ ] **Step 3: Verify script syntax/dry-run and commit**

```bash
node --check scripts/cloud-osc-compression-ui-acceptance.mjs
node scripts/cloud-osc-compression-ui-acceptance.mjs --dry-run
git add scripts/cloud-osc-compression-ui-acceptance.mjs
git commit -m "test: add cloud compression UI soak"
```

Expected: syntax and selector-contract checks pass without opening a browser during dry-run.

---

### Task 8: Full Regression, ESP-IDF Build, and Immutable App Archive

**Repository:** Firmware/cloud, with Web regression checks

**Files:**
- Generated: `build/uart_ble_wifi.bin`
- Archive: `/mnt/d/Users/sunqi39/Desktop/archives/cloud-waveform-compression-20260727/`

**Interfaces:**
- Consumes: committed Tasks 1-7.
- Produces: a tested app-only image and checksum-verified recovery metadata.

- [ ] **Step 1: Run all affected regression suites**

```bash
python3 scripts/cloud_waveform_codec_regression.py --check-fixtures
python3 scripts/cloud_ws_waveform_negotiation_regression.py
python3 scripts/cloud_waveform_cross_language_regression.py
python3 scripts/cloud_osc_hardware_acceptance_regression.py
python3 scripts/cloud_ws_downlink_regression.py
python3 scripts/cloud_ws_fanout_regression.py
python3 scripts/cloud_ws_keepalive_regression.py
python3 scripts/cloud_session_auth_regression.py
cc -std=c11 -Wall -Wextra -Werror -Imain scripts/cloud_ws_compression_state_regression.c -o /tmp/cloud_ws_compression_state_regression
/tmp/cloud_ws_compression_state_regression
```

From the Web repository:

```bash
npm run test:frame-router
npm run test:osc-worker
npm run test:modbus-request
npm run test:param-batch-read
npm run test:modbus-osc-cloud-transport
npm run build
node --check scripts/cloud-osc-compression-ui-acceptance.mjs
```

Expected: every command exits 0; no Web production asset is copied or deployed because this phase changes no browser runtime code.

- [ ] **Step 2: Build with Windows ESP-IDF 6.0**

```text
cmd.exe /C "cd /D D:\Users\sunqi39\Desktop\.codex-fw-osc-continuity-20260723 && C:\esp\v6.0\esp-idf\export.bat >nul 2>nul && idf.py build"
```

Expected: `Project build complete.`, `uart_ble_wifi.bin` generated, and app size below the `0x280000` app partition.

- [ ] **Step 3: Archive only the app plus complete recovery metadata**

```bash
archive=/mnt/d/Users/sunqi39/Desktop/archives/cloud-waveform-compression-20260727
test ! -e "$archive"
mkdir -p "$archive/app" "$archive/source"
install -m 0644 build/uart_ble_wifi.bin build/flasher_args.json build/flash_args partitions.csv sdkconfig "$archive/app/"
git rev-parse HEAD > "$archive/source/firmware-cloud-commit.txt"
git -C /mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723 rev-parse HEAD > "$archive/source/web-commit.txt"
git diff --stat > "$archive/source/firmware-cloud-diff-stat.txt"
git -C /mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723 diff --stat > "$archive/source/web-diff-stat.txt"
find "$archive" -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > "$archive/SHA256SUMS"
(cd "$archive" && sha256sum -c SHA256SUMS)
```

Expected: every file reports `OK`; `flasher_args.json` maps only the app artifact to `0x10000` for the planned flash command. Bootloader, partition table, and storage images are not copied as flash inputs.

- [ ] **Step 4: Record pre-flash recovery references**

```bash
archive=/mnt/d/Users/sunqi39/Desktop/archives/cloud-waveform-compression-20260727
printf '%s\n' \
  'cloud_backup=/home/ubuntu/wireless-debug-cloud/backups/waveform-codec-before-20260727' \
  'known_good_app=/mnt/d/Users/sunqi39/Desktop/archives/osc-continuity-20260724-153621/flash-artifacts/uart_ble_wifi.bin' \
  > "$archive/RECOVERY.txt"
find "$archive" -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > "$archive/SHA256SUMS"
(cd "$archive" && sha256sum -c SHA256SUMS)
```

Expected: `RECOVERY.txt` contains only these two non-secret recovery paths and every archive file reports `OK`.

---

### Task 9: Explicit Gate and App-Only Flash

**Repository:** Firmware/cloud build output

**Files:**
- Flash input: `build/uart_ble_wifi.bin`
- Offset: `0x10000`

**Interfaces:**
- Consumes: hash-verified Task 8 app image.
- Produces: device running schema 6 without touching bootloader, partition table, or SPIFFS.

- [ ] **Step 1: Stop and wait for explicit user confirmation**

Do not probe or write the serial port until the user confirms the device is in download mode and the cable is secure.

- [ ] **Step 2: Detect FTDI and identify the chip**

```text
D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -c "import serial.tools.list_ports as p; print('\n'.join(f'{x.device}\t{x.description}\t{x.hwid}' for x in p.comports()))"
D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -m esptool --chip esp32s3 -p COM4 -b 115200 chip-id
```

Expected: use the detected FTDI `0403:6001` port (historically COM4) and identify ESP32-S3. If either check fails, do not flash.

- [ ] **Step 3: Flash exactly one app image at one offset**

```text
D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -m esptool --chip esp32s3 -p COM4 -b 460800 --before default-reset --after hard-reset write-flash --flash-mode dio --flash-freq 80m --flash-size 8MB 0x10000 D:\Users\sunqi39\Desktop\.codex-fw-osc-continuity-20260723\build\uart_ble_wifi.bin
```

Expected: `Hash of data verified.` and hard reset. The command contains no `0x0`, `0x8000`, or `0x290000` write.

- [ ] **Step 4: Return to normal boot and verify negotiation**

Remove the download jumper, reset, wait for STA/cloud reconnect, request fresh device status, and require `schema_version == 6`, `connected == true`, `compression_capable == true`, `compression_active == true`, and `queue_in_psram == true` before starting sustained tests.

---

### Task 10: Hardware Acceptance, Fault Injection, and Local Non-Regression

**Repositories:** Firmware/cloud and Web

**Files:**
- Evidence: `/tmp/cloud-waveform-60s.json`
- Evidence: `/tmp/cloud-waveform-reconnect.json`
- Evidence: `/tmp/cloud-parameter-5min.json`
- Evidence: `/tmp/cloud-waveform-compression-ui.json`
- Evidence: `/tmp/cloud-waveform-compression-ui.png`
- Evidence: `/tmp/local-waveform-regression.json`

**Interfaces:**
- Consumes: server-first deployment and schema-6 app.
- Produces: objective pass/fail evidence for every approved acceptance target.

- [ ] **Step 1: Run the stable 60-second cloud address test**

```bash
ssh -o BatchMode=yes tencent-wireless 'cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python; sudo docker compose exec -T cloud python - --mode cloud --device-id wd-ac276eab7c9c --duration 60 --no-inject-fallback --min-bytes-per-second 60000 --max-p95-ms 100 --max-gap-ms 750 --cloud-http http://127.0.0.1:18088 --cloud-ws ws://127.0.0.1:18089' < scripts/cloud_osc_hardware_acceptance.py | tee /tmp/cloud-waveform-60s.json
```

Expected: decoded throughput at least `60 KB/s`; P95 delivery gap at most `100 ms`; max gap at most `750 ms`; heartbeat ACK P95 at most `500 ms`; heartbeat max below `2000 ms`; wire/raw ratio below `0.20`; compression average at most `5 ms`, max at most `10 ms`; cloud decode average at most `1 ms`; internal minimum heap at least `8 KB`; zero queue, overflow, send, browser-drop, decode, fallback, and accounting failures.

- [ ] **Step 2: Force one duplicate-uplink replacement**

```bash
ssh -o BatchMode=yes tencent-wireless 'cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python; sudo docker compose exec -T cloud python - --mode cloud --device-id wd-ac276eab7c9c --duration 30 --inject-fallback --min-bytes-per-second 15000 --max-p95-ms 100 --max-gap-ms 750 --cloud-http http://127.0.0.1:18088 --cloud-ws ws://127.0.0.1:18089' < scripts/cloud_osc_hardware_acceptance.py | tee /tmp/cloud-waveform-reconnect.json
```

Expected: bounded MQTT fallback is observed with zero fallback failure, raw WebSocket reconnects, `WDC1` negotiation repeats, compression returns active, and no source chunk is double-counted.

- [ ] **Step 3: Run the five-minute cloud parameter soak**

```bash
ssh -o BatchMode=yes tencent-wireless 'cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python; sudo docker compose exec -T -e CLOUD_WS_URL=ws://127.0.0.1:18089/ws/device/wd-ac276eab7c9c -e CYCLES=600 -e INTERVAL_MS=500 -e TIMEOUT_MS=2800 cloud python -' < /mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723/scripts/cloud-modbus-continuity.py | tee /tmp/cloud-parameter-5min.json
```

Expected: sampling runs all five minutes, isolated misses do not stop it or fabricate samples, and three consecutive failures remain the only terminal condition. Preserve actual request/response counts even if the verdict fails.

- [ ] **Step 4: Run the real browser soak**

Load credentials into environment variables without printing them, then run from the Web repository:

```bash
WIRELESS_DEBUG_PW_RUNNER=/tmp/wireless_debug_playwright_runner CLOUD_REMOTE_URL=https://wd.claudcode.xyz/remote/wd-ac276eab7c9c/orig/i.html PARAM_TABLE=/mnt/d/Users/sunqi39/Downloads/ParameterTable.xlsx node scripts/cloud-osc-compression-ui-acceptance.mjs
```

Expected: parameter page remains running for five minutes; address page remains running for 60 seconds; cache reaches at least 30 seconds; browser receives at least 3.6 MB; screenshot shows nonblank continuous plots without the doubled wrap edge.

- [ ] **Step 5: Re-run local AP address and parameter regression**

After connecting the PC to the ESP AP:

```bash
scripts/run_cloud_osc_hardware_acceptance.sh --mode local --duration 20 --min-bytes-per-second 15000 --max-p95-ms 50 --max-gap-ms 750 --output /tmp/local-waveform-regression.json
```

Run the same browser workflow against the local page with shorter regression durations:

```bash
TARGET_MODE=local CLOUD_REMOTE_URL=http://192.168.4.1/orig/i.html PARAM_DURATION_MS=30000 ADDRESS_DURATION_MS=20000 PARAM_TABLE=/mnt/d/Users/sunqi39/Downloads/ParameterTable.xlsx node scripts/cloud-osc-compression-ui-acceptance.mjs
```

Expected: the local protocol and UI verdicts pass, both charts render, and local WebSocket payload bytes retain the pre-change raw framing.

- [ ] **Step 6: Capture final identities and report truthfully**

```bash
git -C /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723 status -sb
git -C /mnt/d/Users/sunqi39/Desktop/.codex-osc-continuity-20260723 status -sb
sha256sum /mnt/d/Users/sunqi39/Desktop/.codex-fw-osc-continuity-20260723/build/uart_ble_wifi.bin
(cd /mnt/d/Users/sunqi39/Desktop/archives/cloud-waveform-compression-20260727 && sha256sum -c SHA256SUMS)
```

Expected: both worktrees are clean, app hash matches the archive, cloud files match deployed hashes, and every acceptance JSON has `passed: true`. If any threshold fails, report that exact metric and keep the evidence; do not declare success.

## Rollback

If cloud deployment fails, restore `app.py`, `Dockerfile`, and `docker-compose.yml` from the exact Task 3 backup, remove only the newly deployed `waveform_codec.py`, and rebuild only `cloud`:

```bash
ssh -o BatchMode=yes tencent-wireless 'set -e
cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python
backup=/home/ubuntu/wireless-debug-cloud/backups/waveform-codec-before-20260727
cp -a "$backup/app.py" app.py
cp -a "$backup/Dockerfile" Dockerfile
cp -a "$backup/docker-compose.yml" docker-compose.yml
rm -f waveform_codec.py
sudo docker compose up -d --build --no-deps cloud
sudo docker compose ps cloud
'
```

Use only this exact backup after verifying its `SHA256SUMS`; never select a backup by wildcard.

If firmware acceptance fails, wait for explicit download-mode confirmation and flash only the archived last-known-good app at `0x10000`:

```text
D:\Users\sunqi39\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe -m esptool --chip esp32s3 -p COM4 -b 460800 --before default-reset --after hard-reset write-flash --flash-mode dio --flash-freq 80m --flash-size 8MB 0x10000 D:\Users\sunqi39\Desktop\archives\osc-continuity-20260724-153621\flash-artifacts\uart_ble_wifi.bin
```

New server plus rolled-back firmware remains legacy raw. New firmware plus rolled-back server sends one harmless browser-rejected `WDC1` fragment, receives no reply, and remains legacy raw. Nginx, PostgreSQL, Mosquitto, bootloader, partition table, and SPIFFS remain untouched in both rollback paths.
