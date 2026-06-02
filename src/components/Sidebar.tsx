import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { Activity, LayoutDashboard, LineChart, Users, ScrollText, LogOut, Wifi, WifiOff, Target, Brain, Radio, Zap, Crosshair, Sigma } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModeStore } from "@/stores/mode.store";
import { clearToken } from "@/lib/auth";
import { useConnectionStatus } from "@/hooks/useConnectionStatus";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  // { to: "/chart", label: "Chart", icon: LineChart },
  // { to: "/custom-chart", label: "Chart", icon: LineChart },
  // { to: "/trade", label: "Order", icon: ClipboardList },
  // Intel V1 (legacy) — hidden. Re-enable by uncommenting.
  // { to: "/intel", label: "Intel Terminal", icon: Radar },
  { to: "/intel-v2", label: "Intel V2 Console", icon: Radio },
  // Intel V3 Ultimate — hidden. Re-enable by uncommenting.
  // { to: "/intel-v3", label: "Intel V3 Ultimate",  icon: Crosshair },
  // Intel V4 Decision — hidden. Re-enable by uncommenting.
  // { to: "/intel-v4", label: "Intel V4 Decision",  icon: Zap },
  // Intel V5 Verdict — hidden. Re-enable by uncommenting.
  // { to: "/intel-v5", label: "Intel V5 Verdict",   icon: Crosshair },
  { to: "/intel-v6", label: "Intel V6 Master Engine", icon: Sigma },
  // { to: "/nifty50", label: "Nifty 50", icon: Target },
  { to: "/scalping", label: "Intraday Scalping Algo AI", icon: Brain },
  // { to: "/accounts", label: "Accounts", icon: Users },
  // { to: "/logs", label: "Logs", icon: ScrollText },
] as const;

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const router = useRouter();
  const { mode, setMode } = useModeStore();
  const { connected } = useConnectionStatus();

  const onLogout = () => {
    clearToken();
    router.invalidate();
    navigate({ to: "/login" });
  };

  const isProd = mode === "production";

  return (
    <aside className="group fixed left-0 top-0 z-50 h-screen w-16 -translate-x-[52px] border-r border-border bg-card transition-transform duration-200 ease-out hover:translate-x-0 hover:shadow-2xl hover:shadow-black/50">
      {/* Thin grab handle shown while the bar is collapsed */}
      <div className="pointer-events-none absolute right-0 top-1/2 h-10 w-1 -translate-y-1/2 rounded-l bg-primary/40 transition-opacity duration-200 group-hover:opacity-0" />
      <div className="flex h-full flex-col">
        {/* Logo */}
        <div className="flex h-16 items-center justify-center border-b border-border px-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Activity className="h-6 w-6 text-primary flex-shrink-0" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Dhan Copy-Trader</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 p-2">
          {NAV_ITEMS.map((item) => {
            const active =
              item.to === "/"
                ? location.pathname === "/"
                : location.pathname.startsWith(item.to);
            const Icon = item.icon;
            
            return (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>
                  <Link
                    to={item.to}
                    className={cn(
                      "flex items-center justify-center rounded-lg py-3 text-sm font-medium transition-colors",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    <Icon className="h-5 w-5 flex-shrink-0" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{item.label}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        {/* Bottom Actions */}
        <div className="border-t border-border p-2 space-y-2">
          {/* Connection Status */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center justify-center py-2">
                {connected ? (
                  <Wifi className="h-5 w-5 text-emerald-500" />
                ) : (
                  <WifiOff className="h-5 w-5 text-destructive" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{connected ? "Backend Online" : "Backend Offline"}</p>
            </TooltipContent>
          </Tooltip>

          {/* Mode Toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center justify-center py-2">
                <Switch
                  checked={isProd}
                  onCheckedChange={(checked) => setMode(checked ? "production" : "sandbox")}
                  aria-label="Toggle production mode"
                  className="scale-75"
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{isProd ? "Production Mode" : "Sandbox Mode"}</p>
            </TooltipContent>
          </Tooltip>

          {/* Logout */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onLogout}
                className="flex w-full items-center justify-center rounded-lg py-3 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <LogOut className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Logout</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </aside>
  );
}
