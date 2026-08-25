# Cloud Waveform End-to-End Tracing Design

## Purpose

Add a disabled-by-default diagnostic facility that traces waveform and control
data from the ESP32 UART callback through cloud transport, browser parsing, and
chart rendering. The trace must identify the first stage whose output rate,
latency, queue depth, or byte accounting exceeds expectations without changing
the waveform protocol or materially perturbing the timing being measured.

The diagnostic facility remains in the product after this investigation. It is
inactive by default and can be enabled for future incidents.

## Non-Goals

- Do not change waveform bytes, envelope negotiation, compression decisions,
  queue policy, browser pacing, or chart behavior while adding diagnostics.
- Do not modify Nginx, authentication, PostgreSQL, Mosquitto, SPIFFS,
  bootloader, or partition tables.
- Do not continuously stream formatted per-frame logs from the ESP32.
- Do not place credentials, UART payload bytes, or private data in trace files.

## Approach

Each process keeps two complementary diagnostic surfaces:

1. A low-cost stage ledger with counters, byte totals, latency totals/maxima,
   queue high-water marks, and overwrite counts.
2. A bounded ring of fixed-shape trace events for chronological correlation.

Hot paths append numeric records only. Formatting and JSON serialization happen
after capture stops. Rate-limited warnings are emitted only for anomalies such
as long waits, queue pressure, drops, decode rejection, or slow sends.

## Correlation Model

No bytes are added to the existing `WDZ1` envelope. Cross-process correlation
uses fields already available at both ends:

- `raw_len`
- raw CRC32 from the envelope header
- `wire_len`
- per-connection send/receive ordinal

Firmware and cloud connection generations are local identifiers. The report
first pairs generations using their capability exchange, then pairs envelope
events in order using `(raw_len, crc32, wire_len)` and each side's local ordinal.
Firmware UART batches and 512-byte queue chunks use local monotonically
increasing IDs. Aggregate events record the first and last source IDs plus source
count.

After cloud decode, fanout and browser delivery are correlated by cumulative
decoded-stream byte ranges. The cloud assigns `[stream_start, stream_end)` to
each decoded message and records how fanout coalescing, splitting, or dropping
changes those ranges. Browser diagnostics record cumulative received bytes and
parser consumption, allowing missing ranges to be located without embedding
trace metadata in production waveform bytes.

Heartbeats receive dedicated ordinal counters at every stage because their
payload is recognizable and their latency determines the motor watchdog result.

## Firmware Instrumentation

### Event Storage

Allocate the event ring in PSRAM with a fixed capacity selected at compile time.
Each event contains only numeric fields:

- monotonic timestamp in microseconds
- event type
- local sequence or aggregate range
- byte length
- CRC32 when already available or inexpensive
- queue depth or source count
- duration or status code

Ring append uses a short critical section around the write index. When full, it
overwrites the oldest event and increments `trace_overwrites`. Capture state is
checked before any event construction so disabled overhead is one predictable
branch per instrumented boundary.

### Boundaries

Record these stages:

- UART callback begin/end: callback ID, length, inter-arrival time, callback
  duration, and cumulative UART bytes.
- Cloud split/enqueue: source callback ID, chunk ID, length, queue depth before
  and after, enqueue duration, queue-full eviction, and high-water mark.
- Sender wake/dequeue: wake timestamp, oldest chunk age, queue depth, and sender
  scheduling gap.
- Aggregate: first/last chunk IDs, source count, raw length, CRC32, and aggregate
  construction duration.
- Compression: codec, raw/wire lengths, duration, fallback, and failure.
- WebSocket send: connection generation, send ordinal, wire length, start/end,
  return value, and socket error on failure.
- WebSocket downlink: receive ordinal, event fragmentation, complete-frame time,
  callback duration, and failure reason.
- UART transmit: control-frame classification, length, write duration, result.
- UART heartbeat reply: callback ID, queue chunk ID, aggregate/send ordinal, and
  queue residence time.

The existing status schema gains additive summary fields for every boundary,
including call/byte counts, total/max durations, queue high-water marks, event
ring capacity, event count, and overwrite count.

### Export

Cloud control commands start, stop, clear, and page through a completed firmware
capture. Export occurs only after capture stops. Pages are sent over the existing
control/MQTT path and contain numeric JSON records; they never contain raw UART
payloads. Export failure and missing-page counters are explicit.

## Cloud Instrumentation

### Uplink Decode

Record connection generation, receive ordinal, wire length, envelope identity,
arrival gap, decode duration, decoded length, and rejection reason. Maintain
arrival-gap and decode-duration histograms in addition to the event ring.

### Browser Fanout

Extend the fanout sender with a process-wide diagnostic collector. Record:

- decoded stream byte range enqueued for each browser
- queue depth and high-water mark
- queue wait duration
- coalesced and split ranges
- send duration and send gap
- dropped range and reason
- sender close/error

The collector is independent of the browser connection lock and uses bounded
storage. `/health` exposes only summaries. A protected debug endpoint controls
capture and returns paginated events after stop.

## Browser Instrumentation

Diagnostics are available through a small module and a test-only global export;
there is no permanent visible debug panel.

Record:

- WebSocket message ordinal, length, receive gap, and cumulative byte range
- frameRouter bytes buffered/consumed/discarded and resynchronization reason
- parsed frame count, CRC result, footer condition, payload bytes, and samples
- worker input/output counts and processing duration
- cache appended/evicted samples and cache duration
- chart batch size, render start/end, animation-frame gap, and long-frame count
- heartbeat command ordinal and matching reply receive time

Browser event storage is a bounded typed-array-backed ring where practical. The
Playwright acceptance script starts/stops capture and writes browser events and
summaries to JSON after the run.

## Capture Coordination

A diagnostic run follows this sequence:

1. Clear and start cloud capture.
2. Clear and start firmware capture through the protected cloud control path.
3. Load the browser page and start browser capture.
4. Run the unchanged address or parameter oscilloscope workflow.
5. Stop browser capture, stop waveform traffic, then stop firmware and cloud
   capture.
6. Export all three event streams and status snapshots.
7. Build one offline report sorted by normalized timestamps and correlation
   keys.

Clock domains are not assumed synchronized. The report aligns them using the
capability exchange and repeated heartbeat request/reply pairs, then reports
residual alignment error. Within each process, monotonic timestamps remain the
source of truth.

## Diagnostic Report

The report includes:

- per-stage input/output calls and bytes
- conservation checks between adjacent stages
- throughput, median, P95, and maximum gap per stage
- queue high-water marks, wait times, drops, and overwrite counts
- compression ratio and CPU duration
- socket and browser send duration distributions
- heartbeat timeline across all observable boundaries
- parser/sample/cache/render output rates
- the first stage where bytes stop balancing or latency exceeds its budget

Raw trace files are retained even when report generation fails.

## Safety And Overhead Budgets

- Diagnostics disabled: no allocation, no serialization, no logging, and only a
  capture-enabled branch at each boundary.
- Diagnostics enabled: fixed PSRAM/RAM bounds; no unbounded queue or file growth.
- Event append target: less than 10 microseconds average and 50 microseconds max
  on firmware, measured by a self-overhead counter.
- Rate-limited warning logs: at most one warning per category per second.
- Capturing must not alter envelope bytes, local AP bytes, queue policy, or cloud
  browser payload bytes.
- If a ring overwrites data, the report fails explicitly rather than silently
  drawing conclusions from an incomplete trace.

## Testing

### Unit And Contract Tests

- Ring wrap, ordering, clear/start/stop, and overwrite accounting.
- Disabled path does not append or allocate.
- Aggregate source-ID range and envelope correlation tuple generation.
- Cloud stream byte-range split/coalesce/drop accounting.
- Browser parser/cache/render conservation on deterministic fixture replay.
- Capture APIs require existing authentication and reject capture export while
  capture is still active.

### Integration Tests

- Feed deterministic UART fixtures through firmware host helpers and restore the
  expected stage ledger.
- Feed deterministic `WDZ1` fixtures through cloud decode and fanout, including
  intentional pump drops.
- Replay the existing browser fixture and verify byte, frame, sample, and render
  counts remain conserved.
- Verify diagnostics-disabled production regressions and ESP-IDF build.

### Hardware Test

Run the same 60-second cloud address workflow without relaxed thresholds. Export
all event streams and generate the report. The diagnostic implementation is
accepted only if:

- all capture files are present and parseable
- no ring overwrite occurred
- disabled-mode local and cloud bytes remain unchanged
- report conservation checks identify either a clean stage or an exact first
  failing boundary
- capture overhead stays within the stated budget

The trace identifies the next production fix; the diagnostic task itself does
not claim to solve the waveform reliability defect.
