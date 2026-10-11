import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readQuota, writeQuota, clearQuota, quotaCachePath } from '../apis/utils/quota-cache.mjs';

test('quota cache writes, reads and clears under CRUCIX_HOME', () => {
  assert.equal(readQuota('quota-self-test'), null);
  assert.equal(writeQuota('quota-self-test', { blockedUntil: 42 }), true);
  assert.equal(readQuota('quota-self-test').blockedUntil, 42);
  assert.ok(existsSync(quotaCachePath('quota-self-test')));
  clearQuota('quota-self-test');
  assert.equal(readQuota('quota-self-test'), null);
});

test('quota cache rejects an unsafe name', () => {
  assert.throws(() => quotaCachePath('../secret'), /invalid quota cache name/);
});
