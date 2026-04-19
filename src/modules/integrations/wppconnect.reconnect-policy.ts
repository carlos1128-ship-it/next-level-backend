const RECOVERABLE_REASONS = new Set([
  'DISCONNECTED',
  'autocloseCalled',
  'bootstrap_failed',
  'browserClose',
  'page_closed',
  'phoneNotConnected',
  'qr_timeout',
  'serverClose',
]);

const QR_TERMINAL_REASONS = new Set([
  'deleteToken',
  'desconnectedMobile',
  'disconnectedMobile',
  'qrReadError',
  'qrReadFail',
  'sessionUnpaired',
]);

export function shouldAttemptAutoReconnect(reason: string | null | undefined) {
  if (!reason) {
    return false;
  }

  return RECOVERABLE_REASONS.has(reason);
}

export function isQrTerminalReason(reason: string | null | undefined) {
  if (!reason) {
    return false;
  }

  return QR_TERMINAL_REASONS.has(reason);
}

export function computeReconnectDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
) {
  const safeAttempt = Math.max(1, attempt);
  const safeBaseDelay = Math.max(1000, baseDelayMs);
  const safeMaxDelay = Math.max(safeBaseDelay, maxDelayMs);
  const delay = safeBaseDelay * 2 ** (safeAttempt - 1);

  return Math.min(delay, safeMaxDelay);
}
