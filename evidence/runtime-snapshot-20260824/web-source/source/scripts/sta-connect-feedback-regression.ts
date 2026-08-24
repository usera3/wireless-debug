import { strict as assert } from 'node:assert';
import { evaluateStaConnectAttempt } from '../src/lib/wifiStaFeedback';

{
  const feedback = evaluateStaConnectAttempt({
    mode: 'AP',
    sta_configured: false,
    sta_connecting: false,
    sta_connected: false,
    sta_ssid: '',
    sta_ip: '-',
  }, 0);

  assert.equal(feedback.done, true);
  assert.equal(feedback.kind, 'err');
  assert.match(feedback.message, /先网页配网/);
}

{
  const feedback = evaluateStaConnectAttempt({
    mode: 'STA',
    sta_configured: true,
    sta_connecting: true,
    sta_connected: false,
    sta_ssid: 'desktop',
    sta_ip: '-',
  }, 3000);

  assert.equal(feedback.done, false);
  assert.equal(feedback.kind, 'ing');
  assert.match(feedback.message, /正在连接外部 WiFi/);
  assert.match(feedback.message, /desktop/);
}

{
  const feedback = evaluateStaConnectAttempt({
    mode: 'STA',
    sta_configured: true,
    sta_connecting: false,
    sta_connected: true,
    sta_ssid: 'desktop',
    sta_ip: '192.168.1.88',
  }, 5000);

  assert.equal(feedback.done, true);
  assert.equal(feedback.kind, 'ok');
  assert.match(feedback.message, /已连接外部 WiFi/);
  assert.match(feedback.message, /192\.168\.1\.88/);
}

{
  const feedback = evaluateStaConnectAttempt({
    mode: 'AP',
    sta_configured: true,
    sta_connecting: false,
    sta_connected: false,
    sta_ssid: 'desktop',
    sta_ip: '-',
  }, 2500);

  assert.equal(feedback.done, true);
  assert.equal(feedback.kind, 'err');
  assert.match(feedback.message, /连接外部 WiFi失败/);
  assert.match(feedback.message, /desktop/);
}

{
  const feedback = evaluateStaConnectAttempt({
    mode: 'STA',
    sta_configured: true,
    sta_connecting: false,
    sta_connected: false,
    sta_ssid: 'desktop',
    sta_ip: '-',
  }, 13000);

  assert.equal(feedback.done, true);
  assert.equal(feedback.kind, 'err');
  assert.match(feedback.message, /超时/);
}
