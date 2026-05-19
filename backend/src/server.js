const env = require('./config/env');
const logger = require('./utils/logger');
const { connectDB } = require('./config/db');
const app = require('./app');
const http = require('http');
const { Server } = require('socket.io');
const marketDataService = require('./services/marketData.service');
const hybridLiveFeedService = require('./services/hybridLiveFeed.service');

const server = http.createServer(app);

// Setup Socket.IO
const io = new Server(server, {
  cors: {
    origin: env.frontendOrigin === '*' ? true : env.frontendOrigin.split(',').map((s) => s.trim()),
    credentials: false,
  },
});

// Initialize scalping socket emitter
const scalpingSocket = require('./utils/scalpingSocket');
scalpingSocket.initializeSocket(io);

// Store active subscriptions
const subscriptions = new Map();
const liveSubscriptions = new Map(); // Track live feed subscriptions

io.on('connection', (socket) => {
  logger.info({ socketId: socket.id }, 'Client connected');

  // Subscribe to market data
  socket.on('subscribe', async ({ symbol, interval }) => {
    const key = `${symbol}_${interval}`;
    logger.info({ socketId: socket.id, symbol, interval }, 'Client subscribed to market data');
    
    socket.join(key);
    
    // Track subscription
    if (!subscriptions.has(key)) {
      subscriptions.set(key, new Set());
    }
    subscriptions.get(key).add(socket.id);
  });

  // Unsubscribe from market data
  socket.on('unsubscribe', ({ symbol, interval }) => {
    const key = `${symbol}_${interval}`;
    logger.info({ socketId: socket.id, symbol, interval }, 'Client unsubscribed from market data');
    
    socket.leave(key);
    
    // Remove from tracking
    if (subscriptions.has(key)) {
      subscriptions.get(key).delete(socket.id);
      if (subscriptions.get(key).size === 0) {
        subscriptions.delete(key);
      }
    }
  });

  // Load historical data
  socket.on('loadHistorical', async ({ 
    symbol, 
    interval, 
    range, 
    endTime, 
    dataSource = 'dhan', 
    authKey,
    securityId,
    exchange,
    segment,
    instrument
  }) => {
    try {
      logger.info({ 
        socketId: socket.id, 
        symbol, 
        interval, 
        range, 
        endTime, 
        dataSource, 
        hasAuthKey: !!authKey,
        securityId,
        exchange,
        segment,
        instrument
      }, 'Loading historical data');
      
      let result;
      
      // Route to Dhan Bypass if selected
      if (dataSource === 'dhan-bypass') {
        if (!authKey) {
          socket.emit('historicalData', {
            success: false,
            error: 'Auth key required for Dhan Bypass',
          });
          return;
        }
        
        const dhanBypassService = require('./services/dhanBypass.service');
        
        // Calculate time range
        const timeRange = dhanBypassService.calculateBypassTimeRange(
          range,
          endTime ? parseInt(endTime, 10) : null
        );
        
        // Map interval to Dhan Bypass format
        const intervalMap = {
          '1m': '1',
          '5m': '5',
          '15m': '15',
          '30m': '30',
          '1h': '60',
          '1d': '1D',
        };
        
        const bypassInterval = intervalMap[interval] || '5';
        
        // Use provided securityId or map symbol to security ID
        let finalSecurityId = securityId;
        let finalExchange = exchange || 'IDX';
        let finalSegment = segment || 'I';
        let finalInstrument = instrument || 'IDX';
        
        if (!finalSecurityId) {
          const symbolToSecurityId = {
            '^NSEI': 13,
            '^NSEBANK': 25,
          };
          finalSecurityId = symbolToSecurityId[symbol] || 13;
        }
        
        result = await dhanBypassService.getDhanBypassData(authKey, {
          securityId: finalSecurityId,
          exchange: finalExchange,
          segment: finalSegment,
          instrument: finalInstrument,
          startTime: timeRange.startTime,
          endTime: timeRange.endTime,
          interval: bypassInterval,
        });
        
        // Add symbol and interval to result for consistency
        if (result.ok) {
          result.data.symbol = symbol;
          result.data.interval = interval;
          result.data.range = range;
        }
      } else {
        // Use standard market data service for Dhan API or Yahoo Finance
        result = await marketDataService.getHistoricalData(
          symbol,
          interval,
          range,
          endTime ? parseInt(endTime, 10) : null,
          dataSource
        );
      }
      
      if (result.ok) {
        socket.emit('historicalData', {
          success: true,
          data: result.data,
        });
      } else {
        socket.emit('historicalData', {
          success: false,
          error: result.error,
        });
      }
    } catch (error) {
      logger.error({ error: error.message, socketId: socket.id }, 'Error loading historical data');
      socket.emit('historicalData', {
        success: false,
        error: error.message,
      });
    }
  });

  // Enable live feed via Hybrid service (WebSocket + Polling)
  socket.on('enableLiveFeed', async ({ securityIds, exchangeSegment = 'IDX_I', interval = '1m', authKey, exchange, segment, instrument }) => {
    try {
      logger.info({ socketId: socket.id, securityIds, exchangeSegment, interval }, 'Enabling hybrid live feed');
      
      // Ensure securityIds is an array
      const ids = Array.isArray(securityIds) ? securityIds : [securityIds];
      
      // Initialize hybrid service (only happens once)
      await hybridLiveFeedService.initialize();
      
      // Create callback to send updates to this socket
      const callback = (data) => {
        socket.emit('liveFeedUpdate', {
          securityId: data.securityId,
          data: data.candle,
        });
      };
      
      // Subscribe via hybrid service (auto-routes to WebSocket or polling)
      hybridLiveFeedService.subscribe(
        ids,
        exchangeSegment,
        interval,
        callback,
        authKey,
        exchange,
        segment,
        instrument
      );
      
      // Track subscription for cleanup
      if (!liveSubscriptions.has(socket.id)) {
        liveSubscriptions.set(socket.id, []);
      }
      liveSubscriptions.get(socket.id).push({ securityIds: ids, exchangeSegment, callback });
      
      const status = hybridLiveFeedService.getStatus();
      
      socket.emit('liveFeedStatus', {
        success: true,
        message: 'Hybrid live feed enabled',
        status: status,
      });
    } catch (error) {
      logger.error({ error: error.message, socketId: socket.id }, 'Error enabling hybrid live feed');
      socket.emit('liveFeedStatus', {
        success: false,
        error: error.message,
      });
    }
  });

  // Disable live feed
  socket.on('disableLiveFeed', ({ securityIds, exchangeSegment = 'IDX_I' }) => {
    try {
      logger.info({ socketId: socket.id, securityIds, exchangeSegment }, 'Disabling hybrid live feed');
      
      // Unsubscribe from hybrid service
      if (liveSubscriptions.has(socket.id)) {
        liveSubscriptions.get(socket.id).forEach(({ securityIds: sids, exchangeSegment: seg, callback }) => {
          hybridLiveFeedService.unsubscribe(sids, seg, callback);
        });
        liveSubscriptions.delete(socket.id);
      }
      
      socket.emit('liveFeedStatus', {
        success: true,
        message: 'Hybrid live feed disabled',
      });
    } catch (error) {
      logger.error({ error: error.message, socketId: socket.id }, 'Error disabling hybrid live feed');
      socket.emit('liveFeedStatus', {
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================================
  // SCALPING ALGO REAL-TIME UPDATES
  // ============================================================
  
  // Subscribe to scalping session updates
  socket.on('subscribeScalping', ({ sessionId }) => {
    const room = sessionId ? `scalping_${sessionId}` : 'scalping_all';
    socket.join(room);
    logger.info({ socketId: socket.id, room }, 'Client subscribed to scalping updates');
  });
  
  // Unsubscribe from scalping updates
  socket.on('unsubscribeScalping', ({ sessionId }) => {
    const room = sessionId ? `scalping_${sessionId}` : 'scalping_all';
    socket.leave(room);
    logger.info({ socketId: socket.id, room }, 'Client unsubscribed from scalping updates');
  });

  socket.on('disconnect', () => {
    logger.info({ socketId: socket.id }, 'Client disconnected');
    
    // Clean up subscriptions
    subscriptions.forEach((sockets, key) => {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        subscriptions.delete(key);
      }
    });
    
    // Clean up live feed subscriptions
    if (liveSubscriptions.has(socket.id)) {
      liveSubscriptions.get(socket.id).forEach(({ securityIds, exchangeSegment, callback }) => {
        hybridLiveFeedService.unsubscribe(securityIds, exchangeSegment, callback);
      });
      liveSubscriptions.delete(socket.id);
    }
  });
});

// Broadcast real-time updates (simulated for now, can be connected to actual market feed)
// This would be replaced with actual market data feed integration
setInterval(async () => {
  for (const [key, sockets] of subscriptions.entries()) {
    if (sockets.size > 0) {
      const [symbol, interval] = key.split('_');
      
      // Fetch latest candle (in production, this would come from a real-time feed)
      try {
        const result = await marketDataService.getHistoricalData(symbol, interval, '1d');
        if (result.ok && result.data.candles.length > 0) {
          const latestCandle = result.data.candles[result.data.candles.length - 1];
          io.to(key).emit('candleUpdate', {
            symbol,
            interval,
            candle: latestCandle,
          });
        }
      } catch (error) {
        logger.error({ error: error.message, key }, 'Error fetching real-time data');
      }
    }
  }
}, 60000); // Update every minute

async function start() {
  await connectDB();
  server.listen(env.port, 'localhost', () => {
    logger.info(`Server listening on http://localhost:${env.port} (${env.nodeEnv})`);
    logger.info('WebSocket server ready');
  });

  // Boot the production Dhan WebSocket feed and subscribe to core indices + futures.
  try {
    const { instance: liveFeedProd } = require('./services/dhanLiveFeedProd.service');
    const { instance: feedRecorder } = require('./services/feedRecorder.service');
    const { instance: tickDelta } = require('./services/hybrid/tickDeltaClassifier');
    const microstructure = require('./services/hybrid/microstructureEngine');
    const niftyFuturesProd = require('./services/niftyFuturesProd.service');
    const candleSynthesizer = require('./services/candleSynthesizer.service');
    feedRecorder.init(); // start day-rollover + prune old folders
    // Start the candle synthesizer — reads 1m candles from live-feed folder
    // every 3 seconds and synthesizes missing 5m/15m candles so the hybrid
    // engine always has full ATR/volume-profile history from session start.
    candleSynthesizer.start();
    // CALIBRATED 2026-05-19: live-feed integrity guardian — dedupe + synth
    // missing higher-TF candles. Runs every 60s while market is open.
    // Independent of scalping session so duplicates from previous server
    // runs are cleaned up on boot regardless.
    try {
      require('./services/liveFeedIntegrity.service').start({ intervalMs: 60_000 });
    } catch (e) {
      logger.warn({ err: e.message }, '[server] liveFeedIntegrity start failed');
    }
    // Start the tick-level UP/DOWN classifier BEFORE we connect, so it sees
    // every tick from the very first packet. Listening is event-driven and
    // adds zero latency to the feed parser.
    tickDelta.start(liveFeedProd);
    // Start the microstructure engine — listens to depth-bearing FULL-mode
    // ticks (NIFTY futures + index 50/depth) and computes bid/ask
    // imbalance, absorption, iceberg, liquidity-pull, and spoofing reads.
    microstructure.start(liveFeedProd);
    await liveFeedProd.connect();
    // Default subscriptions — NIFTY 50 (13) in QUOTE mode (indices have no depth).
    // The microstructure engine will get its depth feed from the futures
    // subscription below (FULL mode), which is the institutional read anyway —
    // futures lead spot in microstructure.
    liveFeedProd.subscribe(
      [
        { exchangeSegment: 'IDX_I', securityId: 13 }, // NIFTY 50 — required (only focus)
        { exchangeSegment: 'IDX_I', securityId: 25 }, // BANK NIFTY — context only
      ],
      'QUOTE'
    );
    // Subscribe NIFTY futures (near-month contract)
    await niftyFuturesProd.subscribeLiveFeed('FULL');
    logger.info('[server] Dhan production live feed + feed recorder + futures + tick-delta classifier + microstructure engine started');
  } catch (e) {
    logger.warn({ err: e.message }, '[server] Dhan production live feed failed to start (will retry on demand)');
  }
}

start().catch((err) => {
  logger.error({ err: err.message }, 'Failed to start server');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Uncaught exception');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing server gracefully');
  hybridLiveFeedService.disconnect();
  try { require('./services/candleSynthesizer.service').stop(); } catch (_) {}
  try { require('./services/liveFeedIntegrity.service').stop(); } catch (_) {}
  try { require('./services/hybrid/tickDeltaClassifier').instance.stop(); } catch (_) {}
  try { require('./services/hybrid/microstructureEngine').stop(); } catch (_) {}
  try { require('./services/dhanLiveFeedProd.service').instance.disconnect(); } catch (_) {}
  try { require('./services/feedRecorder.service').instance.shutdown(); } catch (_) {}
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, closing server gracefully');
  hybridLiveFeedService.disconnect();
  try { require('./services/candleSynthesizer.service').stop(); } catch (_) {}
  try { require('./services/liveFeedIntegrity.service').stop(); } catch (_) {}
  try { require('./services/hybrid/tickDeltaClassifier').instance.stop(); } catch (_) {}
  try { require('./services/hybrid/microstructureEngine').stop(); } catch (_) {}
  try { require('./services/dhanLiveFeedProd.service').instance.disconnect(); } catch (_) {}
  try { require('./services/feedRecorder.service').instance.shutdown(); } catch (_) {}
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

module.exports = { io };
