const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const env = require('./config/env');
const { notFoundHandler, errorHandler } = require('./middleware/error');

const authRoutes = require('./routes/auth.routes');
const accountRoutes = require('./routes/account.routes');
const tradeRoutes = require('./routes/trade.routes');
const dataRoutes = require('./routes/data.routes');
const marketDataRoutes = require('./routes/marketData.routes');
const optionsRoutes = require('./routes/options.routes');
const dhanBypassRoutes = require('./routes/dhanBypass.routes');
const dhanProdRoutes = require('./routes/dhanProd.routes');
const liveFeedProdRoutes = require('./routes/liveFeedProd.routes');
const feedRecorderRoutes = require('./routes/feedRecorder.routes');
const historicalBackfillRoutes = require('./routes/historicalBackfill.routes');
const nifty50OrdersRoutes = require('./routes/nifty50Orders.routes');
const scalpingRoutes = require('./routes/scalping.routes');
const intelRoutes = require('./routes/intel.routes');
const intelV2Routes = require('./routes/intelV2.routes');

const app = express();

app.use(helmet());
// Wide-open CORS — frontend can be served from any LAN host (e.g.
// http://192.168.0.104:5173) and still hit this API. The backend itself
// is auth-protected per route, so origin restriction would only block
// legitimate dev/LAN access.
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);
app.use(express.json({ limit: '1mb' }));
if (env.nodeEnv !== 'test') {
  app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
}

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) =>
  res.json({ name: 'dhan-copytrader-backend', status: 'running', env: env.nodeEnv })
);

// Live feed status endpoint
app.get('/api/live-feed/status', (_req, res) => {
  const hybridLiveFeedService = require('./services/hybridLiveFeed.service');
  const status = hybridLiveFeedService.getStatus();
  res.json({
    ok: true,
    liveFeedStatus: status,
    message: status.websocketConnected 
      ? 'Using WebSocket for indices, Polling for options'
      : 'Using Polling only (WebSocket not connected)',
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/trade', tradeRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/market-data', marketDataRoutes);
app.use('/api/options', optionsRoutes);
app.use('/api/dhan-bypass', dhanBypassRoutes);
app.use('/api/dhan-prod', dhanProdRoutes);
app.use('/api/live-feed-prod', liveFeedProdRoutes);
app.use('/api/feed-recorder', feedRecorderRoutes);
app.use('/api/backfill', historicalBackfillRoutes);
app.use('/api/nifty50-orders', nifty50OrdersRoutes);
app.use('/api/scalping', scalpingRoutes);
app.use('/api/intel', intelRoutes);
app.use('/api/intel-v2', intelV2Routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
