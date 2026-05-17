/**
 * AI Advisory Layer (Optional Side Channel)
 * -----------------------------------------
 * In the hybrid blueprint, AI is NOT in the execution path. It only provides
 * advisory commentary in special situations. Off by default — enable per
 * session via `settings.enableHybridAIAdvisory = true`.
 *
 * Triggers (only one of these reaches AI):
 *   - regime uncertainty   (marketRegime.regime === 'unknown' or 'reversal_risk')
 *   - anomaly suspicion    (volatility.state === 'panic' or 'event_driven')
 *   - fake-breakout suspicion (caller passes flag)
 *   - news-event window    (caller passes flag)
 *
 * Even when invoked, AI's response is treated as ADVISORY:
 *   - it can lower confidence
 *   - it can raise risk warnings
 *   - it CANNOT flip direction
 *   - it CANNOT bypass any tier-1 hard gate
 *   - it CANNOT inject a new strike
 *
 * Failures are non-fatal: if AI errors out the engine proceeds with the
 * deterministic decision unchanged.
 */

const logger = require('../../utils/logger');
const aiIOLogger = require('../../utils/aiIOLogger');

let openai = null;
try {
  openai = require('../openai.service');
} catch (_) {
  // Engine still works without the openai module — advisory just becomes a no-op.
}

const ADVISORY_SYSTEM_PROMPT = `
You are an institutional risk advisor. You DO NOT make trade decisions.
You see the deterministic engine's intent and you only flag risks.

You will receive:
  - the deterministic decision (direction, score, regime, reasoning)
  - relevant context (regime, volatility, recent news flag)

Reply with strict JSON, no markdown:
{
  "advise": "PROCEED" | "REDUCE_SIZE" | "BLOCK",
  "confidence_adjustment": <integer between -3 and 0>,
  "size_factor": <number 0..1, default 1>,
  "warnings": ["..."],
  "reasoning": "<= 2 short sentences"
}

Rules:
  - If you see regime/news clearly contradicting the intent, "BLOCK".
  - If you see ambiguity, "REDUCE_SIZE" with size_factor 0.5–0.75.
  - Otherwise "PROCEED".
  - Never propose a different direction or strike.
`.trim();

function _shouldInvoke({ marketRegime, volatilityRegime, fakeBreakoutSuspected, newsWindow }) {
  if (fakeBreakoutSuspected) return 'fake_breakout';
  if (newsWindow) return 'news_window';
  if (volatilityRegime?.state === 'panic') return 'volatility_panic';
  if (volatilityRegime?.state === 'event_driven') return 'event_driven';
  if (marketRegime?.regime === 'reversal_risk') return 'reversal_risk';
  if (marketRegime?.regime === 'unknown') return 'regime_unknown';
  return null;
}

/**
 * @param {Object} args
 * @param {Object} args.deterministicDecision - what the hybrid engine intends to do
 * @param {Object} args.context              - { marketRegime, volatilityRegime, ... }
 * @param {Object} args.session              - ScalpingSession (for ai model)
 * @param {boolean} [args.enabled=false]
 * @param {boolean} [args.fakeBreakoutSuspected]
 * @param {boolean} [args.newsWindow]
 * @returns {Promise<Object|null>} advisory result or null if skipped
 */
async function consult({
  deterministicDecision,
  context,
  session,
  enabled = false,
  fakeBreakoutSuspected = false,
  newsWindow = false,
} = {}) {
  if (!enabled) return null;
  if (!openai || typeof openai.callOpenAICustom !== 'function') return null;

  const trigger = _shouldInvoke({
    marketRegime: context?.marketRegime,
    volatilityRegime: context?.volatilityRegime,
    fakeBreakoutSuspected,
    newsWindow,
  });
  if (!trigger) return null;

  const payload = {
    trigger,
    deterministicDecision,
    context: {
      session: context?.session?.phase,
      marketRegime: context?.marketRegime?.regime,
      volatility: context?.volatilityRegime?.state,
      liquidityHealth: context?.liquidity?.health,
      derivatives: {
        bias: context?.derivatives?.overallBias,
        score: context?.derivatives?.directionScore,
      },
    },
  };

  let raw;
  try {
    raw = await openai.callOpenAICustom({
      systemPrompt: ADVISORY_SYSTEM_PROMPT,
      userPayload: payload,
      model: session?.aiModel || 'gpt-4o-mini',
      temperature: 0.1,
      responseFormat: 'json',
      purpose: `hybrid_advisory_${trigger}`,
    });
  } catch (e) {
    logger.warn({ err: e.message, trigger }, '[hybrid:ai-advisory] OpenAI failed (non-fatal)');
    return { advise: 'PROCEED', confidence_adjustment: 0, size_factor: 1, warnings: [], reasoning: 'advisory unreachable', _failed: true };
  }

  try { aiIOLogger.logAICall?.({
    purpose: `hybrid_advisory_${trigger}`,
    model: session?.aiModel || 'gpt-4o-mini',
    systemPrompt: ADVISORY_SYSTEM_PROMPT,
    userPrompt: JSON.stringify(payload),
    responseText: typeof raw === 'string' ? raw : JSON.stringify(raw),
    parsedResponse: raw,
    sessionId: String(session?._id || ''),
  }); } catch (_) {}

  const out = typeof raw === 'string' ? _safeParse(raw) : (raw || {});
  return {
    advise: ['PROCEED', 'REDUCE_SIZE', 'BLOCK'].includes(out.advise) ? out.advise : 'PROCEED',
    confidence_adjustment: clampInt(out.confidence_adjustment, -3, 0),
    size_factor: Number.isFinite(Number(out.size_factor)) ? Math.max(0, Math.min(1, Number(out.size_factor))) : 1,
    warnings: Array.isArray(out.warnings) ? out.warnings.slice(0, 5) : [],
    reasoning: String(out.reasoning || '').slice(0, 280),
    trigger,
  };
}

function _safeParse(s) {
  try { return JSON.parse(s); } catch (_) {
    const m = String(s).match(/\{[\s\S]*\}/);
    if (!m) return {};
    try { return JSON.parse(m[0]); } catch (_) { return {}; }
  }
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

module.exports = { consult };
