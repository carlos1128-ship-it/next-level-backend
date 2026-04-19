import test from 'node:test';
import assert from 'node:assert/strict';
import { WppSessionStateManager } from './wpp-session-state.manager';

test('snapshot expõe retry e limpeza cancela timers/listeners', async () => {
  const manager = new WppSessionStateManager();
  let disposed = 0;

  manager.setReconnectState('empresa-1', {
    reconnectAttempts: 2,
    nextReconnectAt: Date.now() + 1000,
    lastReconnectAt: Date.now(),
  });
  manager.setReconnectTimer('empresa-1', setTimeout(() => undefined, 1000));
  manager.setQrTimeoutTimer('empresa-1', setTimeout(() => undefined, 1000));
  manager.setListeners('empresa-1', [
    {
      dispose: () => {
        disposed += 1;
      },
    },
  ]);

  const snapshot = manager.snapshot('empresa-1');
  assert.equal(snapshot.hasReconnectTimer, true);
  assert.equal(snapshot.reconnectAttempts, 2);
  assert.equal(Boolean(snapshot.nextReconnectAt), true);
  assert.equal(Boolean(snapshot.lastReconnectAt), true);

  manager.clear('empresa-1');
  assert.equal(disposed, 1);
  assert.equal(manager.get('empresa-1'), null);
});
