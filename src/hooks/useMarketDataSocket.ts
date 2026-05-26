import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { API_BASE_URL } from '@/lib/api';
import { getDhanBypassKey } from '@/lib/dhanBypass';

// Resolve fresh from window.location each connection so the socket
// follows the page host on the LAN.
function getSocketUrl(): string {
  if (import.meta.env.VITE_API_BASE_URL) return String(import.meta.env.VITE_API_BASE_URL);
  const port = import.meta.env.VITE_BACKEND_PORT || '3000';
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const proto = window.location.protocol === 'https:' ? 'https' : 'http';
    return `${proto}://${window.location.hostname}:${port}`;
  }
  return API_BASE_URL;
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface HistoricalDataResponse {
  success: boolean;
  data?: {
    symbol: string;
    interval: string;
    range: string;
    candles: Candle[];
    meta: any;
  };
  error?: string;
}

interface UseMarketDataSocketOptions {
  symbol: string;
  interval: string;
  range: string;
  targetDate?: Date;
  dataSource?: 'dhan' | 'yahoo' | 'dhan-bypass';
  securityId?: string | number;
  exchange?: string;
  segment?: string;
  instrument?: string;
  enableLiveFeed?: boolean;
  onCandleUpdate?: (candle: Candle) => void;
  onHistoricalData?: (data: Candle[]) => void;
  onLiveFeedUpdate?: (data: any) => void;
  onError?: (error: string) => void;
}

export function useMarketDataSocket({
  symbol,
  interval,
  range,
  targetDate,
  dataSource = 'dhan',
  securityId,
  exchange,
  segment,
  instrument,
  enableLiveFeed = false,
  onCandleUpdate,
  onHistoricalData,
  onLiveFeedUpdate,
  onError,
}: UseMarketDataSocketOptions) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLiveFeedActive, setIsLiveFeedActive] = useState(false);

  // Initialize socket connection
  useEffect(() => {
    const socket = io(getSocketUrl(), {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('WebSocket connected');
      setIsConnected(true);
      
      // Subscribe to market data
      socket.emit('subscribe', { symbol, interval });
    });

    socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);
    });

    socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
      if (onError) {
        onError('Connection error: ' + error.message);
      }
    });

    // Handle real-time candle updates
    socket.on('candleUpdate', ({ candle }: { symbol: string; interval: string; candle: Candle }) => {
      console.log('[useMarketDataSocket] Candle update received:', { symbol, interval, candle });
      if (onCandleUpdate) {
        onCandleUpdate(candle);
      }
    });

    // Handle historical data response
    socket.on('historicalData', (response: HistoricalDataResponse) => {
      setIsLoading(false);
      
      if (response.success && response.data) {
        if (onHistoricalData) {
          onHistoricalData(response.data.candles);
        }
      } else if (response.error) {
        console.error('Historical data error:', response.error);
        if (onError) {
          onError(response.error);
        }
      }
    });

    // Handle live feed updates
    socket.on('liveFeedUpdate', ({ securityId: sid, data }: { securityId: string | number; data: any }) => {
      console.log('[useMarketDataSocket] Live feed update received:', { securityId: sid, data });
      
      // Convert to candle format if needed
      if (data && typeof data === 'object') {
        const candle: Candle = {
          time: data.time || Math.floor(Date.now() / 1000),
          open: data.open || 0,
          high: data.high || 0,
          low: data.low || 0,
          close: data.close || 0,
          volume: data.volume || 0,
        };
        
        console.log('[useMarketDataSocket] Converted to candle:', candle);
        
        // Update via candle update handler
        if (onCandleUpdate) {
          onCandleUpdate(candle);
        }
        
        // Also call live feed update handler if provided
        if (onLiveFeedUpdate) {
          onLiveFeedUpdate(data);
        }
      }
    });

    // Handle live feed status
    socket.on('liveFeedStatus', ({ success, message, error }: { success: boolean; message?: string; error?: string }) => {
      if (success) {
        console.log('Live feed status:', message);
        setIsLiveFeedActive(true);
      } else {
        console.error('Live feed error:', error);
        setIsLiveFeedActive(false);
        if (onError) {
          onError(error || 'Live feed error');
        }
      }
    });

    return () => {
      socket.emit('unsubscribe', { symbol, interval });
      
      // Disable live feed if active
      if (securityId) {
        socket.emit('disableLiveFeed', {
          securityIds: [securityId],
          exchangeSegment: segment || 'IDX_I',
        });
      }
      
      socket.disconnect();
    };
  }, [symbol, interval, securityId, segment, onCandleUpdate, onHistoricalData, onLiveFeedUpdate, onError]);

  // Load initial data
  const loadInitialData = useCallback(() => {
    if (socketRef.current && isConnected) {
      setIsLoading(true);
      
      const params: any = {
        symbol,
        interval,
        range: range || '1w', // Default to 1 week if not specified
        dataSource,
      };

      // If target date is provided, calculate the time range
      if (targetDate) {
        const endTime = Math.floor(targetDate.getTime() / 1000);
        params.endTime = endTime;
      }

      // If using dhan-bypass, include auth key and option parameters
      if (dataSource === 'dhan-bypass') {
        const authKey = getDhanBypassKey();
        if (authKey) {
          params.authKey = authKey;
        }
        
        // Add option-specific parameters if provided
        if (securityId) params.securityId = securityId;
        if (exchange) params.exchange = exchange;
        if (segment) params.segment = segment;
        if (instrument) params.instrument = instrument;
      }

      socketRef.current.emit('loadHistorical', params);
    }
  }, [symbol, interval, range, targetDate, dataSource, securityId, exchange, segment, instrument, isConnected]);

  // Load more historical data (week by week)
  const loadMoreData = useCallback((endTime: number) => {
    if (socketRef.current && isConnected) {
      setIsLoading(true);
      
      const params: any = {
        symbol,
        interval,
        range: '1w', // Always load 1 week at a time when scrolling back
        endTime,
        dataSource,
      };

      // If using dhan-bypass, include auth key and option parameters
      if (dataSource === 'dhan-bypass') {
        const authKey = getDhanBypassKey();
        if (authKey) {
          params.authKey = authKey;
        }
        
        // Add option-specific parameters if provided
        if (securityId) params.securityId = securityId;
        if (exchange) params.exchange = exchange;
        if (segment) params.segment = segment;
        if (instrument) params.instrument = instrument;
      }

      socketRef.current.emit('loadHistorical', params);
    }
  }, [symbol, interval, dataSource, securityId, exchange, segment, instrument, isConnected]);

  // Enable/disable live feed
  const toggleLiveFeed = useCallback((enable: boolean) => {
    if (socketRef.current && isConnected && securityId) {
      if (enable) {
        // Get auth key from storage if using dhan-bypass
        const authKey = dataSource === 'dhan-bypass' ? getDhanBypassKey() : undefined;
        
        socketRef.current.emit('enableLiveFeed', {
          securityIds: [securityId],
          exchangeSegment: segment || 'D',
          interval: interval,
          authKey: authKey,
          exchange: exchange || 'NSE',
          segment: segment || 'D',
          instrument: instrument || 'OPTIDX',
        });
      } else {
        socketRef.current.emit('disableLiveFeed', {
          securityIds: [securityId],
          exchangeSegment: segment || 'D',
        });
        setIsLiveFeedActive(false);
      }
    }
  }, [securityId, segment, interval, dataSource, exchange, instrument, isConnected]);

  // Auto-enable live feed if requested
  useEffect(() => {
    if (enableLiveFeed && isConnected && securityId) {
      toggleLiveFeed(true);
    }
  }, [enableLiveFeed, isConnected, securityId, toggleLiveFeed]);

  return {
    isConnected,
    isLoading,
    isLiveFeedActive,
    loadInitialData,
    loadMoreData,
    toggleLiveFeed,
  };
}
