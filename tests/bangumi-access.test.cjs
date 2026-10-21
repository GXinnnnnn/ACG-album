'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAccessToken, safeAccessError } = require('../src/bangumi-access.cjs');
test('Bearer Token accepts documented characters and trims surrounding clipboard spaces', () => {
  assert.equal(normalizeAccessToken('  synthetic.ABC-123_~+/==  '), 'synthetic.ABC-123_~+/==');
  assert.equal(normalizeAccessToken(''), '');
  assert.equal(normalizeAccessToken(undefined), '');
});
test('invalid token characters fail before header construction without copying credential to errors', () => {
  for (const token of [
    'synthetic\nsecret',
    'synthetic\r\nsecret',
    'synthetic\0secret',
    'synthetic\tsecret',
    'synthetic secret',
    'synthetic秘密',
    'synthetic=secret'
  ]) {
    assert.throws(
      () => normalizeAccessToken(token),
      (error) => {
        assert.equal(error.code, 'BANGUMI_TOKEN_INVALID');
        assert.match(error.message, /格式无效/);
        assert.ok(!error.message.includes(token));
        assert.ok(!error.stack.includes('synthetic'));
        return true;
      }
    );
  }
});
test('oversized token preserves actionable validation without exposing its value', () => {
  assert.throws(() => normalizeAccessToken('synthetic'.repeat(600)), /Token 过长/);
});
test('header-validation errors are replaced including escaped malformed header representations', () => {
  const error = new TypeError(
    'Headers.append: "Bearer synthetic\\nsecret" is an invalid header value.'
  );
  const safe = safeAccessError(error, 'synthetic\nsecret');
  assert.notEqual(safe, error);
  assert.equal(safe.code, 'BANGUMI_TOKEN_INVALID');
  assert.ok(!safe.message.includes('synthetic'));
  assert.ok(!safe.stack.includes('synthetic'));
  assert.equal(safe.cause, undefined);
});
test('other errors containing a token in message or stack do not reach RPC logs', () => {
  for (const stackOnly of [false, true]) {
    const error = new Error(stackOnly ? 'request failed' : 'request failed: synthetic-token');
    if (stackOnly) error.stack += '\nat fixture (synthetic-token)';
    const safe = safeAccessError(error, 'synthetic-token');
    assert.ok(!safe.message.includes('synthetic-token'));
    assert.ok(!safe.stack.includes('synthetic-token'));
  }
});
test('ordinary cancellation and permission errors remain actionable', () => {
  const error = Object.assign(new Error('匹配任务已取消。'), { code: 'MATCH_CANCELLED' });
  assert.equal(safeAccessError(error, 'synthetic-token'), error);
});
