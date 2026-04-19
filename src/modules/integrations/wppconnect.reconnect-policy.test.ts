import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeReconnectDelay,
  isQrTerminalReason,
  shouldAttemptAutoReconnect,
} from './wppconnect.reconnect-policy';

test('aplica backoff exponencial com teto maximo', () => {
  assert.equal(computeReconnectDelay(1, 10000, 120000), 10000);
  assert.equal(computeReconnectDelay(2, 10000, 120000), 20000);
  assert.equal(computeReconnectDelay(5, 10000, 120000), 120000);
  assert.equal(computeReconnectDelay(8, 10000, 120000), 120000);
});

test('reconhece falhas transitórias para auto-reconnect', () => {
  assert.equal(shouldAttemptAutoReconnect('browserClose'), true);
  assert.equal(shouldAttemptAutoReconnect('serverClose'), true);
  assert.equal(shouldAttemptAutoReconnect('DISCONNECTED'), true);
  assert.equal(shouldAttemptAutoReconnect('qrReadError'), false);
  assert.equal(shouldAttemptAutoReconnect('sessionUnpaired'), false);
});

test('reconhece estados terminais que exigem novo QR', () => {
  assert.equal(isQrTerminalReason('qrReadError'), true);
  assert.equal(isQrTerminalReason('sessionUnpaired'), true);
  assert.equal(isQrTerminalReason('phoneNotConnected'), false);
});
