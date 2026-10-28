/**
 * Shared request-body helpers.
 *
 * A Worker that parses a request body pays the parsing cost before any
 * authentication check happens. An unauthenticated caller can therefore
 * make the Worker parse a very large body and burn its CPU. The limits
 * here are enforced on the bytes actually read, not on Content-Length:
 * a chunked request can omit or forge that header.
 */

/**
 * The declared body length, if the request carries a usable one.
 * @param {Request} request
 * @returns {number|null}
 */
export function getDeclaredContentLength(request) {
  const raw = request.headers.get('Content-Length');
  if (!raw) return null;
  const length = Number(raw);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

/**
 * Read a request body, aborting as soon as it exceeds the limit.
 *
 * Does not rely on Content-Length: a chunked request can forge or omit
 * that header, so the byte count is enforced while reading.
 *
 * @param {Request} request
 * @param {number} limit maximum number of bytes to accept
 * @returns {Promise<string|null>} the body text, or null when it was too large
 */
export async function readBodyWithLimit(request, limit) {
  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      try {
        await reader.cancel();
      } catch (_) {
      }
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

/**
 * Read and parse a JSON body under a byte limit.
 *
 * Returns one of:
 *   { ok: true,  data }  - parsed body
 *   { ok: false, reason: 'too_large' } - the body exceeded the limit
 *   { ok: false, reason: 'invalid' }  - the body was not valid JSON
 *
 * @param {Request} request
 * @param {number} limit maximum number of bytes to accept
 * @returns {Promise<{ok: boolean, data?: any, reason?: string}>}
 */
export async function readJsonBodyWithLimit(request, limit) {
  const declared = getDeclaredContentLength(request);
  if (declared !== null && declared > limit) {
    return { ok: false, reason: 'too_large' };
  }

  const raw = await readBodyWithLimit(request, limit);
  if (raw === null) {
    return { ok: false, reason: 'too_large' };
  }

  try {
    return { ok: true, data: JSON.parse(raw || '{}') };
  } catch (_) {
    return { ok: false, reason: 'invalid' };
  }
}
