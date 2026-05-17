/**
 * Orderflow State Engine
 * ======================
 * Maps the joint state of price + delta + OI + futures into one of seven
 * institutional orderflow states:
 *
 *   initiative_buying     price ↑ + delta ↑ + OI ↑ + futures ↑    (hold longer)
 *   initiative_selling    price ↓ + delta ↓ + OI ↑ + futures ↓
 *   responsive_buying     price ↓ + delta ↑ + OI flat            (mean revert long)
 *   responsive_selling    price ↑ + delta ↓ + OI flat
 *   absorption            price flat + delta strong              (smart-money positioning)
 *   exhaustion            climactic vol + divergence             (reversal warning)
 *   trapped_breakout      price expansion + weak delta + no OI   (fake)
 *   neutral               default
 *
 * Output drives:
 *   - hold-longer permission for initiative states
 *   - tightening for exhaustion / trapped states
 *   - confirmation requirement for responsive states
 */

function _safe(n) { const x = Number(n); return Number.isFinite(x) ? x : 0; }

/**
 * @param {Object} args
 * @param {Object} args.volumeAnalysis  - includes delta + vsa + timeVolume
 * @param {Object} args.oiAnalytics     - includes diff + regime
 * @param {Object} args.futuresData
 * @param {Object} args.priceMove       - { ptsChange, direction } over last short window
 */
function classify({ volumeAnalysis, oiAnalytics, futuresData, priceMove } = {}) {
  const delta   = volumeAnalysis?.delta;
  const vsa     = volumeAnalysis?.vsa;
  const tv      = volumeAnalysis?.timeVolume;
  const oiDiff  = oiAnalytics?.diff;
  const oiRegime= oiAnalytics?.regime;

  const priceDir = priceMove?.direction;     // 'up' | 'down' | 'flat'
  const ptsChg   = _safe(priceMove?.ptsChange);

  const deltaBias= delta?.bias || 'neutral';
  const deltaPct = _safe(delta?.cvdPctLong);
  const futDir   = futuresData?.direction || futuresData?.futures_direction || 'neutral';

  // Helpers
  const expanding = (oiDiff?.peVelocity > 100 || oiDiff?.ceVelocity > 100);
  const climacticVol = tv?.state === 'climax';
  const dryUp = tv?.state === 'dry_up';
  const divergence = delta?.divergence && delta.divergence !== 'none';

  // INITIATIVE BUYING: price + delta + OI building + futures aligned
  if (priceDir === 'up' && deltaPct >= 15
      && expanding && (oiRegime === 'aggressive_long_buildup' || oiRegime === 'normal')
      && (futDir === 'bullish' || futDir === 'neutral')) {
    return {
      state: 'initiative_buying',
      bias: 'bullish',
      strength: 85,
      holdLonger: true,
      reasoning: `price+delta+OI+futures all positive (${deltaPct}% delta)`,
    };
  }
  // INITIATIVE SELLING (mirror)
  if (priceDir === 'down' && deltaPct <= -15
      && expanding && (oiRegime === 'aggressive_short_buildup' || oiRegime === 'normal')
      && (futDir === 'bearish' || futDir === 'neutral')) {
    return {
      state: 'initiative_selling',
      bias: 'bearish',
      strength: 85,
      holdLonger: true,
      reasoning: `price+delta+OI+futures all negative (${deltaPct}% delta)`,
    };
  }

  // EXHAUSTION: climactic vol + divergence
  if (climacticVol && divergence) {
    return {
      state: 'exhaustion',
      bias: delta.divergenceBias === 'bullish' ? 'bullish' : 'bearish',
      strength: 75,
      holdLonger: false,
      reasoning: `climactic volume + ${delta.divergence}`,
    };
  }

  // TRAPPED BREAKOUT: VSA no_demand / no_supply
  if (vsa?.pattern === 'no_demand') {
    return {
      state: 'trapped_breakout',
      bias: 'bearish',
      strength: 70,
      holdLonger: false,
      reasoning: 'big bullish candle on weak volume — fake breakout',
    };
  }
  if (vsa?.pattern === 'no_supply') {
    return {
      state: 'trapped_breakout',
      bias: 'bullish',
      strength: 70,
      holdLonger: false,
      reasoning: 'big bearish candle on weak volume — fake breakdown',
    };
  }

  // ABSORPTION: VSA absorption pattern OR price flat with delta moving
  if (vsa?.pattern === 'absorption') {
    return {
      state: 'absorption',
      bias: vsa.bias,
      strength: 65,
      holdLonger: false,
      reasoning: `VSA absorption (${vsa.bias})`,
    };
  }
  if (Math.abs(ptsChg) < 5 && Math.abs(deltaPct) >= 25) {
    return {
      state: 'absorption',
      bias: deltaPct > 0 ? 'bullish' : 'bearish',
      strength: 60,
      holdLonger: false,
      reasoning: `price flat (${ptsChg.toFixed(1)}pts) but delta ${deltaPct}%`,
    };
  }

  // RESPONSIVE BUYING: price dipping into support but delta turning positive
  if (priceDir === 'down' && deltaPct >= 5 && !expanding) {
    return {
      state: 'responsive_buying',
      bias: 'bullish',
      strength: 55,
      holdLonger: false,
      reasoning: `responsive buying — price dipping but delta ${deltaPct}%`,
    };
  }
  // RESPONSIVE SELLING (mirror)
  if (priceDir === 'up' && deltaPct <= -5 && !expanding) {
    return {
      state: 'responsive_selling',
      bias: 'bearish',
      strength: 55,
      holdLonger: false,
      reasoning: `responsive selling — price up but delta ${deltaPct}%`,
    };
  }

  // Default
  return {
    state: 'neutral',
    bias: 'neutral',
    strength: 0,
    holdLonger: false,
    reasoning: dryUp ? 'volume dry-up' : 'no clear orderflow state',
  };
}

module.exports = { classify };
