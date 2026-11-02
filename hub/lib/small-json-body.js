'use strict';

function readSmallJson(req, maxBytes = 1024) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(maxBytes) || maxBytes < 0) {
      reject(new Error('invalid_max_bytes'));
      return;
    }

    const rawLength = req && req.headers ? req.headers['content-length'] : undefined;
    if (rawLength !== undefined) {
      if (typeof rawLength !== 'string' || !/^[0-9]+$/.test(rawLength) || Number(rawLength) > maxBytes) {
        reject(new Error('invalid_content_length'));
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', chunk => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        fail(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(bytes);
    });
    req.on('error', fail);
    req.on('end', () => {
      if (settled) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const value = text.length === 0 ? {} : JSON.parse(text);
        settled = true;
        resolve(value);
      } catch (error) {
        fail(error);
      }
    });
  });
}

module.exports = { readSmallJson };
