import axios, { AxiosError } from "axios";
import { getToken, clearToken } from "./auth";

/**
 * API Base URL resolver.
 *
 * Priority:
 *   1. VITE_API_BASE_URL env override (full URL).
 *   2. window.location.hostname + VITE_BACKEND_PORT — auto-follows the
 *      page host so opening http://192.168.0.104:5173 → API hits
 *      http://192.168.0.104:3000, opening http://localhost:5173 →
 *      http://localhost:3000.
 *   3. localhost:3000 fallback (used during SSR / build).
 *
 * IMPORTANT: this resolver is invoked PER REQUEST inside an axios
 * interceptor, NOT at module load. Reason: with TanStack Start the
 * module first evaluates during SSR where `window` is undefined, so a
 * module-level `const` would freeze the URL to `localhost:3000` even
 * after hydration. The interceptor resolves freshly on every request
 * once the browser has a real `window.location`.
 */
const BACKEND_PORT = import.meta.env.VITE_BACKEND_PORT || "3000";

function resolveApiBaseUrl(): string {
  const explicit = import.meta.env.VITE_API_BASE_URL;
  if (explicit) return String(explicit);
  if (typeof window !== "undefined" && window.location?.hostname) {
    const proto = window.location.protocol === "https:" ? "https" : "http";
    return `${proto}://${window.location.hostname}:${BACKEND_PORT}`;
  }
  return `http://localhost:${BACKEND_PORT}`;
}

// Eagerly resolve once for any code that imports `API_BASE_URL` directly
// (e.g. login page hint). The interceptor below ensures real requests
// always pick up the correct host even if this evaluated to localhost on
// the server.
export const API_BASE_URL = resolveApiBaseUrl();

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 5000,
});

// Re-resolve baseURL on every request from the browser. This guarantees
// the URL follows the page host even if the module was imported during
// SSR (where window was undefined → localhost fallback) and never
// re-evaluated after hydration.
api.interceptors.request.use((config) => {
  if (typeof window !== "undefined" && window.location?.hostname) {
    const proto = window.location.protocol === "https:" ? "https" : "http";
    const fresh = `${proto}://${window.location.hostname}:${BACKEND_PORT}`;
    // Only override if user hasn't set an explicit absolute URL on this
    // single request and there's no env-level override.
    if (!import.meta.env.VITE_API_BASE_URL) {
      config.baseURL = fresh;
    }
  }
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      clearToken();
      // Soft redirect to login if not already there.
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export function apiErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    return data?.error || err.message;
  }
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
