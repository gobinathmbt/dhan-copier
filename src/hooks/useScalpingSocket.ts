/**
 * useScalpingSocket Hook
 * Real-time WebSocket updates for scalping algo trading
 *
 * FIXED: Socket no longer reconnects on every render. Callbacks are stored
 * in refs so the useEffect dependency array is stable.
 */
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '@/lib/api';

// Resolve fresh from window.location at connection time. Module-load
// resolution captures the SSR-time fallback value (localhost) and never
// updates after hydration on a LAN host.
function getSocketUrl(): string {
  if (import.meta.env.VITE_API_BASE_URL) return String(import.meta.env.VITE_API_BASE_URL);
  const port = import.meta.env.VITE_BACKEND_PORT || '3000';
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const proto = window.location.protocol === 'https:' ? 'https' : 'http';
    return `${proto}://${window.location.hostname}:${port}`;
  }
  return API_BASE_URL;
}

interface ScalpingSessionUpdate {
  session: any;
  running: boolean;
  openTrades: number;
  timestamp: number;
}

interface ScalpingTradeUpdate {
  type: 'trade_created' | 'trade_updated' | 'trade_closed';
  updateType?: 'price' | 'sl' | 'quantity';
  trade: any;
  sessionId: string;
  timestamp: number;
}

interface ScalpingEngineEvent {
  type: 'engine_started' | 'engine_stopped' | 'cycle_completed';
  session?: any;
  reason?: string;
  sessionId?: string;
  cycleCount?: number;
  cycleType?: 'prediction' | 'monitor';
  timestamp: number;
}

interface UseScalpingSocketOptions {
  sessionId?: string | null;
  enabled?: boolean;
  onSessionUpdate?: (data: ScalpingSessionUpdate) => void;
  onTradeUpdate?: (data: ScalpingTradeUpdate) => void;
  onEngineEvent?: (data: ScalpingEngineEvent) => void;
}

export function useScalpingSocket(options: UseScalpingSocketOptions = {}) {
  const {
    sessionId,
    enabled = true,
    onSessionUpdate,
    onTradeUpdate,
    onEngineEvent,
  } = options;

  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const queryClient = useQueryClient();

  // Store callbacks in refs so the socket effect doesn't re-run when they change
  const onSessionUpdateRef = useRef(onSessionUpdate);
  const onTradeUpdateRef = useRef(onTradeUpdate);
  const onEngineEventRef = useRef(onEngineEvent);
  onSessionUpdateRef.current = onSessionUpdate;
  onTradeUpdateRef.current = onTradeUpdate;
  onEngineEventRef.current = onEngineEvent;

  useEffect(() => {
    if (!enabled) return;

    console.log('[useScalpingSocket] Connecting to WebSocket...');

    const socket = io(getSocketUrl(), {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
    });

    socketRef.current = socket;

    // ---- Connection lifecycle ----
    socket.on('connect', () => {
      console.log('[useScalpingSocket] Connected');
      setConnected(true);
      socket.emit('subscribeScalping', { sessionId: sessionId || null });
    });

    socket.on('disconnect', () => {
      console.log('[useScalpingSocket] Disconnected');
      setConnected(false);
    });

    socket.on('connect_error', (error) => {
      console.error('[useScalpingSocket] Connection error:', error.message);
    });

    // ---- Scalping event handlers ----
    socket.on('scalpingSessionUpdate', (data: ScalpingSessionUpdate) => {
      queryClient.setQueryData(['scalping-status'], (old: any) => ({
        ...old,
        session: data.session,
        running: data.running,
        openTrades: data.openTrades,
      }));
      onSessionUpdateRef.current?.(data);
    });

    socket.on('scalpingTradeUpdate', (data: ScalpingTradeUpdate) => {
      queryClient.setQueryData(
        ['scalping-trades', data.sessionId],
        (old: any[] | undefined) => {
          if (!old) return [data.trade];
          if (data.type === 'trade_created') return [data.trade, ...old];
          if (data.type === 'trade_updated' || data.type === 'trade_closed') {
            return old.map((t) => (t._id === data.trade._id ? data.trade : t));
          }
          return old;
        }
      );
      onTradeUpdateRef.current?.(data);
    });

    socket.on('scalpingEngineEvent', (data: ScalpingEngineEvent) => {
      if (data.type === 'engine_started' || data.type === 'engine_stopped') {
        queryClient.invalidateQueries({ queryKey: ['scalping-status'] });
      }
      onEngineEventRef.current?.(data);
    });

    // ---- Cleanup ----
    return () => {
      console.log('[useScalpingSocket] Cleaning up');
      socket.emit('unsubscribeScalping', { sessionId: sessionId || null });
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
    // Only reconnect when enabled or sessionId actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId]);

  return {
    socket: socketRef.current,
    connected,
  };
}
