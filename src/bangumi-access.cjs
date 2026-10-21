'use strict';
// RFC 6750 b64token characters. Reject unsafe header values before encryption or fetch.
function normalizeAccessToken(value) {
  const token = String(value || '').trim();
  let message = '';
  if (token.length > 4096) message = 'Token 过长。';
  else if (token && !/^[A-Za-z0-9\-._~+/]+=*$/.test(token))
    message = 'Access Token 格式无效，请从 Bangumi 重新复制完整 Token。';
  if (message) {
    const error = new Error(message);
    error.code = 'BANGUMI_TOKEN_INVALID';
    throw error;
  }
  return token;
}
function safeAccessError(error, token = '') {
  const text = String(error?.message || '') + '\n' + String(error?.stack || '');
  if (
    /Headers?\.(?:append|set)|invalid header|header value/i.test(text) ||
    (token && text.includes(token))
  ) {
    const safe = new Error('Bangumi 请求未完成，请检查 Access Token 和网络后重试。');
    safe.code = 'BANGUMI_TOKEN_INVALID';
    return safe;
  }
  return error;
}
module.exports = { normalizeAccessToken, safeAccessError };
