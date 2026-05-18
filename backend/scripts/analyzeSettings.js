/**
 * Settings Analysis & Optimization Helper for Kiro
 * 
 * This script helps Kiro analyze trading performance and optimize settings.
 * Run with: node backend/scripts/analyzeSettings.js
 */

const fs = require('fs');
const path = require('path');
const algoSettings = require('../src/config/algoSettings');

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Read engine logs for a specific date
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Array} Array of log entries
 */
function readEngineLogs(date) {
  const logsDir = path.join(__dirname, '../logs');
  const logFile = path.join(logsDir, `scalping-engine-${date}.log`);
  
  if (!fs.existsSync(logFile)) {
    console.log(`No log file found for ${date}`);
    return [];
  }
  
  const content = fs.readFileSync(logFile, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  
  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Extract trades from logs
 * @param {Array} logs - Log entries
 * @returns {Array} Array of trade objects
 */
function extractTrades(logs) {
  const trades = [];
  
  logs.forEach(log => {
    if (log.msg && log.msg.includes('Trade closed')) {
      // Extract trade data from log message
      const trade = {
        timestamp: log.time,
        message: log.msg,
        // Parse additional data if available
        ...log.trade,
      };
      trades.push(trade);
    }
  });
  
  return trades;
}

/**
 * Calculate performance metrics
 * @param {Array} trades - Array of trade objects
 * @returns {Object} Performance metrics
 */
function calculateMetrics(trades) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgWinPoints: 0,
      avgLossPoints: 0,
      avgPnL: 0,
      totalPnL: 0,
    };
  }
  
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  
  const avgWinPoints = wins.length > 0
    ? wins.reduce((sum, t) => sum + (t.exitPrice - t.entryPrice), 0) / wins.length
    : 0;
    
  const avgLossPoints = losses.length > 0
    ? losses.reduce((sum, t) => sum + (t.exitPrice - t.entryPrice), 0) / losses.length
    : 0;
  
  const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const avgPnL = totalPnL / trades.length;
  
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / trades.length * 100).toFixed(2),
    avgWinPoints: avgWinPoints.toFixed(2),
    avgLossPoints: avgLossPoints.toFixed(2),
    avgPnL: avgPnL.toFixed(2),
    totalPnL: totalPnL.toFixed(2),
  };
}

/**
 * Suggest optimizations based on metrics
 * @param {Object} metrics - Performance metrics
 * @param {Object} currentSettings - Current algo settings
 * @returns {Object} Optimization suggestions
 */
function suggestOptimizations(metrics, currentSettings) {
  const suggestions = [];
  
  // Target points optimization
  if (parseFloat(metrics.avgWinPoints) < currentSettings.targetPoints * 0.8) {
    suggestions.push({
      setting: 'targetPoints',
      current: currentSettings.targetPoints,
      suggested: Math.ceil(parseFloat(metrics.avgWinPoints)),
      reason: `Average win (${metrics.avgWinPoints} pts) is below target. Reduce target to realistic level.`,
    });
  }
  
  // SL points optimization
  if (Math.abs(parseFloat(metrics.avgLossPoints)) < currentSettings.slPoints * 0.8) {
    suggestions.push({
      setting: 'slPoints',
      current: currentSettings.slPoints,
      suggested: Math.ceil(Math.abs(parseFloat(metrics.avgLossPoints)) * 1.1),
      reason: `Average loss (${metrics.avgLossPoints} pts) is tighter than SL. Reduce SL to improve R:R.`,
    });
  }
  
  // Win rate based suggestions
  const winRate = parseFloat(metrics.winRate);
  if (winRate < 50) {
    suggestions.push({
      setting: 'minConfidence',
      current: currentSettings.minConfidence,
      suggested: currentSettings.minConfidence + 1,
      reason: `Win rate (${winRate}%) is low. Increase entry confidence threshold.`,
    });
  } else if (winRate > 70 && metrics.totalTrades < 10) {
    suggestions.push({
      setting: 'minConfidence',
      current: currentSettings.minConfidence,
      suggested: Math.max(1, currentSettings.minConfidence - 1),
      reason: `Win rate (${winRate}%) is high but trade count is low. Reduce confidence to increase opportunities.`,
    });
  }
  
  // R:R ratio check
  const avgWin = Math.abs(parseFloat(metrics.avgWinPoints));
  const avgLoss = Math.abs(parseFloat(metrics.avgLossPoints));
  const actualRR = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 0;
  
  if (actualRR < currentSettings.minRR) {
    suggestions.push({
      setting: 'minRR',
      current: currentSettings.minRR,
      suggested: parseFloat(actualRR),
      reason: `Actual R:R (${actualRR}) is below minimum. Adjust minRR to match reality.`,
    });
  }
  
  return suggestions;
}

// ============================================================
// MAIN ANALYSIS FUNCTION
// ============================================================

function analyzeAndOptimize(date = null) {
  console.log('='.repeat(60));
  console.log('ALGO SETTINGS ANALYSIS & OPTIMIZATION');
  console.log('='.repeat(60));
  console.log();
  
  // Get current settings
  const settings = algoSettings.getSettings();
  console.log('📊 CURRENT SETTINGS:');
  console.log('-------------------');
  console.log(`Target Points: ${settings.targetPoints}`);
  console.log(`SL Points: ${settings.slPoints}`);
  console.log(`Max Hold Time: ${settings.maxHoldTimeSeconds}s`);
  console.log(`Min Confidence: ${settings.minConfidence}`);
  console.log(`Min R:R: ${settings.minRR}`);
  console.log(`Min Lots: ${settings.minLots}`);
  console.log(`Max Lots: ${settings.maxLots}`);
  console.log();
  
  // Read logs
  const targetDate = date || new Date().toISOString().split('T')[0];
  console.log(`📖 READING LOGS FOR: ${targetDate}`);
  console.log('-------------------');
  
  const logs = readEngineLogs(targetDate);
  console.log(`Found ${logs.length} log entries`);
  console.log();
  
  if (logs.length === 0) {
    console.log('⚠️  No logs found. Run the engine first to generate data.');
    return;
  }
  
  // Extract trades
  const trades = extractTrades(logs);
  console.log(`📈 EXTRACTED ${trades.length} TRADES`);
  console.log();
  
  if (trades.length === 0) {
    console.log('⚠️  No completed trades found in logs.');
    return;
  }
  
  // Calculate metrics
  const metrics = calculateMetrics(trades);
  console.log('📊 PERFORMANCE METRICS:');
  console.log('-------------------');
  console.log(`Total Trades: ${metrics.totalTrades}`);
  console.log(`Wins: ${metrics.wins} | Losses: ${metrics.losses}`);
  console.log(`Win Rate: ${metrics.winRate}%`);
  console.log(`Avg Win: ${metrics.avgWinPoints} pts`);
  console.log(`Avg Loss: ${metrics.avgLossPoints} pts`);
  console.log(`Avg P&L: Rs.${metrics.avgPnL}`);
  console.log(`Total P&L: Rs.${metrics.totalPnL}`);
  console.log();
  
  // Generate suggestions
  const suggestions = suggestOptimizations(metrics, settings);
  
  if (suggestions.length === 0) {
    console.log('✅ SETTINGS LOOK OPTIMAL');
    console.log('No changes recommended at this time.');
  } else {
    console.log('💡 OPTIMIZATION SUGGESTIONS:');
    console.log('-------------------');
    suggestions.forEach((s, i) => {
      console.log(`${i + 1}. ${s.setting}`);
      console.log(`   Current: ${s.current}`);
      console.log(`   Suggested: ${s.suggested}`);
      console.log(`   Reason: ${s.reason}`);
      console.log();
    });
    
    console.log('📝 TO APPLY SUGGESTIONS:');
    console.log('-------------------');
    console.log('Edit backend/src/config/algoSettings.js and update:');
    suggestions.forEach(s => {
      console.log(`  ${s.setting}: ${s.suggested},  // was ${s.current}`);
    });
  }
  
  console.log();
  console.log('='.repeat(60));
}

// ============================================================
// CLI INTERFACE
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const date = args[0] || null; // Optional date argument
  
  analyzeAndOptimize(date);
}

module.exports = {
  readEngineLogs,
  extractTrades,
  calculateMetrics,
  suggestOptimizations,
  analyzeAndOptimize,
};
