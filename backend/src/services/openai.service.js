'use strict';

/**
 * ============================================================
 * OPENAI SERVICE — shared OpenAI Chat Completions caller
 * ============================================================
 * Thin shim around the OpenAI Chat Completions endpoint used by
 * the legacy entry / monitor engines:
 *
 *   - `entryEngine.service.js`     → `callOpenAICustom({ ... })`
 *   - `monitorEngine.service.js`   → `callOpenAICustom({ ... })`
 *
 * Both call sites pass:
 *
 *   {
 *     systemPrompt,        // string — system role content
 *     userPayload,         // object — JSON-stringified into the user role
 *     model,               // e.g. 'gpt-4o-mini'
 *     temperature,         // 0..2
 *     responseFormat,      // 'json' | 'text' (default 'json')
 *     purpose,             // free-form tag for aiIOLogger
 *   }
 *
 * ...and treat the return value as EITHER a JSON string or an
 * already-parsed object (the consumers run `typeof raw === 'string'
 * ? safeParse(raw) : raw` themselves). We honour that contract by
 * returning the parsed JSON when `responseFormat === 'json'` and
 * the raw text otherwise.
 *
 * Failure semantics:
 *   - Throws on hard failures (HTTP error, empty response, JSON
 *     parse failure when JSON mode requested). Both consumers
 *     wrap the call in try/catch and degrade to a NO_TRADE /
 *     HOLD safe-default, so propagating the error here is the
 *     right call — it gives them a single failure path.
 *   - Logs every call via `aiIOLogger.logAICall(...)` so the
 *     audit trail captures system/user prompts + raw response +
 *     latency exactly like the other AI services already do.
 *
 * Configuration:
 *   - `OPENAI_API_KEY`   environment variable (required).
 *   - `OPENAI_BASE_URL`  optional override (default
 *                         `https://api.openai.com/v1`).
 *   - Request timeout fixed at 35 s (matches `institutionalAI`).
 * ============================================================
 */

const axios = require('axios');
const logger = require('../utils/logger');
const aiIOLogger = require('../utils/aiIOLogger');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 35000;

function _baseUrl() {
  return process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
}

function _apiKey() {
  return process.env.OPENAI_API_KEY;
}

/**
 * Coerce an arbitrary user payload into the string body the
 * Chat Completions endpoint expects on the `user` role.
 *
 * @param {*} payload
 * @returns {string}
 */
function _stringifyUserPayload(payload) {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return String(payload);
  }
}

/**
 * Call OpenAI Chat Completions with a system prompt + a single
 * user payload. The signature is the one both legacy callers
 * already use; do NOT change it without updating
 * `entryEngine.service.js` and `monitorEngine.service.js`
 * together.
 *
 * @param {Object} params
 * @param {string} params.systemPrompt      System-role content.
 * @param {*}      params.userPayload       User-role payload (object → JSON string).
 * @param {string} [params.model]           OpenAI model identifier.
 * @param {number} [params.temperature]     Sampling temperature.
 * @param {('json'|'text')} [params.responseFormat='json']  Response shape.
 * @param {string} [params.purpose]         aiIOLogger tag.
 * @param {number} [params.timeoutMs]       Per-call timeout override.
 * @param {string} [params.sessionId]       Optional session id passed to aiIOLogger.
 * @returns {Promise<Object|string>}        Parsed JSON object when `responseFormat='json'`, raw text otherwise.
 */
async function callOpenAICustom(params) {
  const opts = params && typeof params === 'object' ? params : {};
  const systemPrompt = typeof opts.systemPrompt === 'string' ? opts.systemPrompt : '';
  const userText = _stringifyUserPayload(opts.userPayload);
  const model = typeof opts.model === 'string' && opts.model.length > 0 ? opts.model : DEFAULT_MODEL;
  const temperature =
    typeof opts.temperature === 'number' && Number.isFinite(opts.temperature)
      ? opts.temperature
      : DEFAULT_TEMPERATURE;
  const responseFormat = opts.responseFormat === 'text' ? 'text' : 'json';
  const purpose = typeof opts.purpose === 'string' && opts.purpose.length > 0 ? opts.purpose : 'unspecified';
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const sessionId = opts.sessionId !== undefined ? opts.sessionId : null;

  const apiKey = _apiKey();
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY is not set');
    try {
      aiIOLogger.logAICall({
        purpose,
        model,
        systemPrompt,
        userPrompt: userText,
        responseText: null,
        parsedResponse: null,
        usage: null,
        latencyMs: 0,
        error: err.message,
        sessionId,
      });
    } catch (_) {
      /* swallow logger failure */
    }
    throw err;
  }

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    temperature,
  };
  if (responseFormat === 'json') {
    requestBody.response_format = { type: 'json_object' };
  }

  const startedAt = Date.now();
  let httpResponse;
  try {
    httpResponse = await axios.post(`${_baseUrl()}/chat/completions`, requestBody, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const detail = err && err.response && err.response.data ? err.response.data : null;
    try {
      logger.error(
        {
          purpose,
          model,
          err: err && err.message,
          status: err && err.response && err.response.status,
          detail,
        },
        '[openai.service] OpenAI call failed',
      );
    } catch (_) {
      /* swallow logger failure */
    }
    try {
      aiIOLogger.logAICall({
        purpose,
        model,
        systemPrompt,
        userPrompt: userText,
        responseText: null,
        parsedResponse: null,
        usage: null,
        latencyMs,
        error: err && err.message ? err.message : 'unknown error',
        sessionId,
      });
    } catch (_) {
      /* swallow logger failure */
    }
    throw err;
  }

  const latencyMs = Date.now() - startedAt;
  const data = httpResponse && httpResponse.data;
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;

  if (typeof text !== 'string' || text.length === 0) {
    const err = new Error('Empty OpenAI response');
    try {
      aiIOLogger.logAICall({
        purpose,
        model,
        systemPrompt,
        userPrompt: userText,
        responseText: null,
        parsedResponse: null,
        usage: data && data.usage ? data.usage : null,
        latencyMs,
        error: err.message,
        sessionId,
      });
    } catch (_) {
      /* swallow logger failure */
    }
    throw err;
  }

  if (responseFormat === 'text') {
    try {
      aiIOLogger.logAICall({
        purpose,
        model,
        systemPrompt,
        userPrompt: userText,
        responseText: text,
        parsedResponse: null,
        usage: data && data.usage ? data.usage : null,
        latencyMs,
        sessionId,
      });
    } catch (_) {
      /* swallow logger failure */
    }
    return text;
  }

  // JSON mode — parse and return the object. Consumers also accept
  // strings (they re-parse via safeParse), but returning a parsed
  // object keeps the audit log and the call site in sync.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseErr) {
    try {
      aiIOLogger.logAICall({
        purpose,
        model,
        systemPrompt,
        userPrompt: userText,
        responseText: text,
        parsedResponse: null,
        usage: data && data.usage ? data.usage : null,
        latencyMs,
        error: `JSON parse failed: ${parseErr.message}`,
        sessionId,
      });
    } catch (_) {
      /* swallow logger failure */
    }
    throw parseErr;
  }

  try {
    aiIOLogger.logAICall({
      purpose,
      model,
      systemPrompt,
      userPrompt: userText,
      responseText: text,
      parsedResponse: parsed,
      usage: data && data.usage ? data.usage : null,
      latencyMs,
      sessionId,
    });
  } catch (_) {
    /* swallow logger failure */
  }

  return parsed;
}

module.exports = {
  callOpenAICustom,
  // Defaults exposed for tests / consumers that want to inspect them.
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
};
