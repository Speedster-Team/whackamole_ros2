"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

type Status = "disconnected" | "connecting" | "connected" | "error";
type Phase = "idle" | "waiting" | "active";

type Rect = { x: number; y: number; w: number; h: number };

type Settings = {
  dotSize: number;
  playArea: Rect | null;
};

type ReactionRecord = {
  id: string;
  outcome: "hit" | "miss";
  reactionMs: number | null;
  x: number;
  y: number;
  at: number;
  reason?: string;
};

const DEFAULT_DOT_SIZE = 84;
const MIN_DOT_SIZE = 32;
const MAX_DOT_SIZE = 200;
const EDGE_MARGIN = 24;
const MIN_DELAY_MS = 0;
const MAX_DELAY_MS = 0;
const ACTIVE_TIMEOUT_MS = 1000;
const DEFAULT_WS_URL = "ws://localhost:8765";
const STORAGE_WS = "whackamole.wsUrl";
const STORAGE_SETTINGS = "whackamole.settings";
const STORAGE_HISTORY = "whackamole.history";
const HISTORY_LIMIT = 500;

const DEFAULT_SETTINGS: Settings = {
  dotSize: DEFAULT_DOT_SIZE,
  playArea: null,
};

const STATUS_LABEL: Record<Status, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Paired",
  error: "Error",
};

const STATUS_DOT: Record<Status, string> = {
  disconnected: "bg-zinc-500",
  connecting: "bg-amber-400 animate-pulse",
  connected: "bg-emerald-400",
  error: "bg-red-500",
};

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/** Active spawn rectangle in local board coords, given current settings + board size. */
function resolveSpawnRect(
  settings: Settings,
  board: { width: number; height: number },
  dotSize: number,
): Rect {
  const fallback: Rect = {
    x: EDGE_MARGIN,
    y: EDGE_MARGIN,
    w: Math.max(dotSize, board.width - 2 * EDGE_MARGIN),
    h: Math.max(dotSize, board.height - 2 * EDGE_MARGIN),
  };
  if (!settings.playArea) return fallback;
  const r = settings.playArea;
  const w = clamp(r.w, dotSize, board.width);
  const h = clamp(r.h, dotSize, board.height);
  const x = clamp(r.x, 0, board.width - w);
  const y = clamp(r.y, 0, board.height - h);
  return { x, y, w, h };
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

export default function WhackAMolePage() {
  const [wsUrl, setWsUrl] = useState(DEFAULT_WS_URL);
  const [status, setStatus] = useState<Status>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [running, setRunning] = useState(false);
  const [dot, setDot] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const [lastReaction, setLastReaction] = useState<number | null>(null);
  const [history, setHistory] = useState<ReactionRecord[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [editingArea, setEditingArea] = useState(false);
  const [draftRect, setDraftRect] = useState<Rect | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [securePage, setSecurePage] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const spawnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spawnAtRef = useRef<number>(0);
  const playAreaRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);
  const settingsRef = useRef(settings);
  const drawStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const isHttps =
      typeof window !== "undefined" &&
      window.location.protocol === "https:";
    setSecurePage(isHttps);
    try {
      const storedUrl = localStorage.getItem(STORAGE_WS);
      if (storedUrl) setWsUrl(storedUrl);
      else if (isHttps) setWsUrl("");
      else if (typeof window !== "undefined")
        setWsUrl(`ws://${window.location.hostname}:8765`);
      const storedSettings = localStorage.getItem(STORAGE_SETTINGS);
      if (storedSettings) {
        const parsed = JSON.parse(storedSettings) as Partial<Settings>;
        setSettings({
          dotSize:
            typeof parsed.dotSize === "number"
              ? clamp(parsed.dotSize, MIN_DOT_SIZE, MAX_DOT_SIZE)
              : DEFAULT_DOT_SIZE,
          playArea:
            parsed.playArea &&
            typeof parsed.playArea.x === "number" &&
            typeof parsed.playArea.y === "number" &&
            typeof parsed.playArea.w === "number" &&
            typeof parsed.playArea.h === "number"
              ? parsed.playArea
              : null,
        });
      }
      const storedHistory = localStorage.getItem(STORAGE_HISTORY);
      if (storedHistory) {
        const parsed = JSON.parse(storedHistory) as ReactionRecord[];
        if (Array.isArray(parsed)) {
          setHistory(parsed.slice(0, HISTORY_LIMIT));
          const lastHit = parsed.find((r) => r.outcome === "hit");
          if (lastHit && typeof lastHit.reactionMs === "number") {
            setLastReaction(lastHit.reactionMs);
          }
        }
      }
    } catch {
      /* localStorage unavailable */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_HISTORY, JSON.stringify(history));
    } catch {
      /* ignore */
    }
  }, [history, hydrated]);

  const send = useCallback((message: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (spawnTimerRef.current) clearTimeout(spawnTimerRef.current);
    if (activeTimerRef.current) clearTimeout(activeTimerRef.current);
    spawnTimerRef.current = null;
    activeTimerRef.current = null;
  }, []);

  const scheduleNext = useCallback(() => {
    clearTimers();
    if (!runningRef.current) return;
    const playArea = playAreaRef.current;
    if (!playArea) return;
    const rect = playArea.getBoundingClientRect();
    const dotSize = settingsRef.current.dotSize;
    const spawn = resolveSpawnRect(
      settingsRef.current,
      { width: rect.width, height: rect.height },
      dotSize,
    );
    const maxLocalX = spawn.x + Math.max(0, spawn.w - dotSize);
    const maxLocalY = spawn.y + Math.max(0, spawn.h - dotSize);
    const localX = randInt(spawn.x, maxLocalX);
    const localY = randInt(spawn.y, maxLocalY);
    const delayMs = randInt(MIN_DELAY_MS, MAX_DELAY_MS);
    const id = makeId();

    setPhase("waiting");
    setDot(null);

    spawnTimerRef.current = setTimeout(() => {
      if (!runningRef.current) return;
      const area = playAreaRef.current;
      if (!area) return;
      const areaRect = area.getBoundingClientRect();
      const centerLocalX = localX + dotSize / 2;
      const centerLocalY = localY + dotSize / 2;
      spawnAtRef.current = performance.now();
      setDot({ id, x: localX, y: localY });
      setPhase("active");
      send({
        type: "spawn",
        id,
        target: {
          x: Math.round(areaRect.left + centerLocalX),
          y: Math.round(areaRect.top + centerLocalY),
        },
        local: { x: Math.round(centerLocalX), y: Math.round(centerLocalY) },
        size: dotSize,
        delayMs,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        screen: { width: window.screen.width, height: window.screen.height },
        board: {
          left: Math.round(areaRect.left),
          top: Math.round(areaRect.top),
          width: Math.round(areaRect.width),
          height: Math.round(areaRect.height),
        },
        playArea: {
          x: Math.round(spawn.x),
          y: Math.round(spawn.y),
          w: Math.round(spawn.w),
          h: Math.round(spawn.h),
        },
        devicePixelRatio: window.devicePixelRatio,
        ts: Date.now(),
      });
      activeTimerRef.current = setTimeout(() => {
        if (!runningRef.current) return;
        send({ type: "miss", id, reason: "timeout", ts: Date.now() });
        setHistory((prev) =>
          [
            {
              id,
              outcome: "miss" as const,
              reactionMs: null,
              x: Math.round(centerLocalX),
              y: Math.round(centerLocalY),
              at: Date.now(),
              reason: "timeout",
            },
            ...prev,
          ].slice(0, HISTORY_LIMIT),
        );
        setDot(null);
        scheduleNext();
      }, ACTIVE_TIMEOUT_MS);
    }, delayMs);
  }, [clearTimers, send]);

  const onHit = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const current = dot;
      if (!current) return;
      const reactionMs = Math.round(performance.now() - spawnAtRef.current);
      if (activeTimerRef.current) {
        clearTimeout(activeTimerRef.current);
        activeTimerRef.current = null;
      }
      const dotSize = settingsRef.current.dotSize;
      send({
        type: "hit",
        id: current.id,
        reactionMs,
        tap: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
        ts: Date.now(),
      });
      setLastReaction(reactionMs);
      setHistory((prev) =>
        [
          {
            id: current.id,
            outcome: "hit" as const,
            reactionMs,
            x: current.x + dotSize / 2,
            y: current.y + dotSize / 2,
            at: Date.now(),
          },
          ...prev,
        ].slice(0, HISTORY_LIMIT),
      );
      setDot(null);
      scheduleNext();
    },
    [dot, scheduleNext, send],
  );

  const connect = useCallback(() => {
    setError(null);
    const trimmed = wsUrl.trim();
    if (!trimmed) {
      setStatus("error");
      setError("Enter a WebSocket URL like wss://robot.example.com:8765.");
      return;
    }
    if (securePage && trimmed.startsWith("ws://")) {
      setStatus("error");
      setError(
        "This page is served over HTTPS, so the browser blocks ws://. Use wss:// (e.g. via a Cloudflare or Tailscale tunnel in front of the WebSocket server).",
      );
      return;
    }
    setStatus("connecting");
    try {
      localStorage.setItem(STORAGE_WS, trimmed);
    } catch {
      /* ignore */
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(trimmed);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    wsRef.current = ws;
    ws.addEventListener("open", () => {
      setStatus("connected");
      setError(null);
      const area = playAreaRef.current;
      const areaRect = area?.getBoundingClientRect();
      const spawn =
        areaRect &&
        resolveSpawnRect(
          settingsRef.current,
          { width: areaRect.width, height: areaRect.height },
          settingsRef.current.dotSize,
        );
      ws.send(
        JSON.stringify({
          type: "hello",
          viewport: { width: window.innerWidth, height: window.innerHeight },
          screen: {
            width: window.screen.width,
            height: window.screen.height,
          },
          board: areaRect
            ? {
                left: Math.round(areaRect.left),
                top: Math.round(areaRect.top),
                width: Math.round(areaRect.width),
                height: Math.round(areaRect.height),
              }
            : null,
          playArea: spawn
            ? {
                x: Math.round(spawn.x),
                y: Math.round(spawn.y),
                w: Math.round(spawn.w),
                h: Math.round(spawn.h),
              }
            : null,
          dotSize: settingsRef.current.dotSize,
          devicePixelRatio: window.devicePixelRatio,
          userAgent: navigator.userAgent,
          ts: Date.now(),
        }),
      );
    });
    ws.addEventListener("close", () => {
      runningRef.current = false;
      setRunning(false);
      clearTimers();
      setDot(null);
      setPhase("idle");
      setStatus((prev) => (prev === "error" ? prev : "disconnected"));
    });
    ws.addEventListener("error", () => {
      setStatus("error");
      setError(
        "Could not reach the robot. Check the URL and that the ROS node is running.",
      );
    });
  }, [clearTimers, securePage, wsUrl]);

  const disconnect = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    clearTimers();
    wsRef.current?.close();
    wsRef.current = null;
    setDot(null);
    setPhase("idle");
    setStatus("disconnected");
  }, [clearTimers]);

  const start = useCallback(() => {
    if (status !== "connected") return;
    runningRef.current = true;
    setRunning(true);
    scheduleNext();
  }, [scheduleNext, status]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    clearTimers();
    setDot(null);
    setPhase("idle");
    send({ type: "stop", ts: Date.now() });
  }, [clearTimers, send]);

  useEffect(() => {
    return () => {
      clearTimers();
      wsRef.current?.close();
    };
  }, [clearTimers]);

  const stats = useMemo(() => {
    const hits = history.filter(
      (h) => h.outcome === "hit" && typeof h.reactionMs === "number",
    );
    if (hits.length === 0) {
      return { avg: null, best: null, count: 0, misses: history.length - hits.length };
    }
    const times = hits.slice(0, 50).map((h) => h.reactionMs as number);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return {
      avg: Math.round(avg),
      best: Math.min(...times),
      count: times.length,
      misses: history.length - hits.length,
    };
  }, [history]);

  const board = playAreaRef.current?.getBoundingClientRect();
  const activeSpawn = useMemo(
    () =>
      board
        ? resolveSpawnRect(
            settings,
            { width: board.width, height: board.height },
            settings.dotSize,
          )
        : null,
    [board, settings],
  );

  const enterAreaEditor = useCallback(() => {
    if (running) stop();
    setShowSettings(false);
    setEditingArea(true);
    setDraftRect(settings.playArea);
  }, [running, settings.playArea, stop]);

  const onEditorPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const target = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - target.left;
      const y = e.clientY - target.top;
      drawStartRef.current = { x, y };
      setDraftRect({ x, y, w: 0, h: 0 });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const onEditorPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const start = drawStartRef.current;
      if (!start) return;
      const target = e.currentTarget.getBoundingClientRect();
      const cx = clamp(e.clientX - target.left, 0, target.width);
      const cy = clamp(e.clientY - target.top, 0, target.height);
      const x = Math.min(start.x, cx);
      const y = Math.min(start.y, cy);
      const w = Math.abs(cx - start.x);
      const h = Math.abs(cy - start.y);
      setDraftRect({ x, y, w, h });
    },
    [],
  );

  const onEditorPointerUp = useCallback(() => {
    drawStartRef.current = null;
  }, []);

  const saveAreaEditor = useCallback(() => {
    if (!draftRect) {
      setEditingArea(false);
      return;
    }
    const dotSize = settingsRef.current.dotSize;
    if (draftRect.w < dotSize || draftRect.h < dotSize) {
      setEditingArea(false);
      setDraftRect(null);
      return;
    }
    setSettings((prev) => ({
      ...prev,
      playArea: {
        x: Math.round(draftRect.x),
        y: Math.round(draftRect.y),
        w: Math.round(draftRect.w),
        h: Math.round(draftRect.h),
      },
    }));
    setEditingArea(false);
    setDraftRect(null);
  }, [draftRect]);

  const cancelAreaEditor = useCallback(() => {
    setEditingArea(false);
    setDraftRect(null);
  }, []);

  const resetPlayArea = useCallback(() => {
    setSettings((prev) => ({ ...prev, playArea: null }));
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    setLastReaction(null);
  }, []);

  return (
    <main className="relative flex flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-3 select-none">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`size-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
            aria-hidden
          />
          <span className="text-sm font-medium">{STATUS_LABEL[status]}</span>
          {status === "connected" && (
            <span className="truncate font-mono text-xs text-white/40">
              {wsUrl}
            </span>
          )}
        </div>
        <div className="flex items-center gap-5 text-xs tabular-nums text-white/60 sm:text-sm">
          <Stat
            label="last"
            value={lastReaction !== null ? `${lastReaction} ms` : "—"}
            accent
          />
          <Stat
            label="avg"
            value={stats.avg !== null ? `${stats.avg} ms` : "—"}
          />
          <Stat
            label="best"
            value={stats.best !== null ? `${stats.best} ms` : "—"}
          />
          <Stat label="n" value={`${stats.count}`} />
        </div>
      </header>

      {status !== "connected" ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <div
            role="form"
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.03] p-6 shadow-xl"
          >
            <h1 className="text-lg font-semibold tracking-tight">
              Pair with robot
            </h1>
            <p className="mt-1 text-sm text-white/50">
              Connect this device to the ROS 2 WebSocket node controlling
              the finger.
            </p>
            <label
              htmlFor="ws-url"
              className="mt-5 block text-xs font-medium uppercase tracking-wide text-white/50"
            >
              WebSocket URL
            </label>
            <input
              id="ws-url"
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
              className="mt-2 w-full rounded-lg border border-white/15 bg-black px-3 py-2 font-mono text-sm focus:border-white/40 focus:outline-none"
              placeholder={
                securePage
                  ? "wss://robot.example.com:8765"
                  : "ws://192.168.1.42:8765"
              }
            />
            {securePage && wsUrl.trim().startsWith("ws://") && (
              <p className="mt-2 text-xs text-amber-300">
                This page is HTTPS — use <code className="font-mono">wss://</code>{" "}
                (plain <code className="font-mono">ws://</code> is blocked by the
                browser).
              </p>
            )}
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            <div className="mt-5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => connect()}
                disabled={status === "connecting" || !wsUrl}
                className="flex-1 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black transition disabled:opacity-50"
              >
                {status === "connecting" ? "Connecting…" : "Connect"}
              </button>
              {status === "error" && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setStatus("disconnected");
                  }}
                  className="rounded-lg border border-white/15 px-4 py-2.5 text-sm"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div
            ref={playAreaRef}
            className="relative flex-1 overflow-hidden bg-black"
          >
            {!running && activeSpawn && !editingArea && (
              <div
                aria-hidden
                className="pointer-events-none absolute rounded-sm border border-dashed border-white/15"
                style={{
                  left: activeSpawn.x,
                  top: activeSpawn.y,
                  width: activeSpawn.w,
                  height: activeSpawn.h,
                }}
              />
            )}

            {dot && (
              <button
                onPointerDown={onHit}
                aria-label="Tap target"
                className="absolute rounded-full bg-green-500 outline-none ring-0 shadow-[0_0_60px_rgba(239,68,68,0.55)] active:bg-red-400"
                style={{
                  left: dot.x,
                  top: dot.y,
                  width: settings.dotSize,
                  height: settings.dotSize,
                  touchAction: "manipulation",
                }}
              />
            )}

            {!running && !editingArea && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-6">
                <p className="text-sm uppercase tracking-[0.2em] text-white/40">
                  Ready
                </p>
                <button
                  type="button"
                  onClick={start}
                  className="pointer-events-auto rounded-full bg-white px-10 py-4 text-xl font-semibold text-black"
                >
                  Start
                </button>
                <p className="max-w-sm px-6 text-center text-xs text-white/40">
                  A dot will appear at a random spot inside the play area
                  after a random delay. Tap it as fast as possible.
                </p>
              </div>
            )}

            {editingArea && (
              <div
                onPointerDown={onEditorPointerDown}
                onPointerMove={onEditorPointerMove}
                onPointerUp={onEditorPointerUp}
                onPointerCancel={onEditorPointerUp}
                className="absolute inset-0 bg-black/80"
                style={{ touchAction: "none" }}
              >
                {draftRect && (
                  <div
                    className="pointer-events-none absolute rounded-sm border-2 border-emerald-400 bg-emerald-400/10"
                    style={{
                      left: draftRect.x,
                      top: draftRect.y,
                      width: draftRect.w,
                      height: draftRect.h,
                    }}
                  >
                    <div className="absolute -top-7 left-0 rounded bg-emerald-400 px-2 py-0.5 text-[10px] font-mono text-black">
                      {Math.round(draftRect.w)} × {Math.round(draftRect.h)}
                    </div>
                  </div>
                )}
                <div className="absolute top-6 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-4 py-2 text-xs text-white/80 backdrop-blur">
                  Drag to define the play area
                </div>
                <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 gap-2">
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={cancelAreaEditor}
                    className="rounded-lg bg-white/15 px-4 py-2 text-sm text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={saveAreaEditor}
                    disabled={
                      !draftRect ||
                      draftRect.w < settings.dotSize ||
                      draftRect.h < settings.dotSize
                    }
                    className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
          <footer className="flex select-none items-center justify-between gap-3 border-t border-white/10 px-5 py-3 text-xs text-white/60">
            <span className="tabular-nums">
              {phase === "active"
                ? "Tap the dot"
                : phase === "waiting"
                  ? "Waiting…"
                  : running
                    ? "Running"
                    : "Idle"}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="rounded-md bg-white/10 px-3 py-1.5 text-white"
              >
                Settings
              </button>
              {running ? (
                <button
                  type="button"
                  onClick={stop}
                  className="rounded-md bg-white/10 px-3 py-1.5 text-white"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={start}
                  className="rounded-md bg-white/10 px-3 py-1.5 text-white"
                >
                  Start
                </button>
              )}
              <button
                type="button"
                onClick={disconnect}
                className="rounded-md bg-white/10 px-3 py-1.5 text-white"
              >
                Disconnect
              </button>
            </div>
          </footer>
        </>
      )}

      {showSettings && (
        <SettingsOverlay
          settings={settings}
          history={history}
          stats={stats}
          board={
            board
              ? { width: Math.round(board.width), height: Math.round(board.height) }
              : null
          }
          activeSpawn={activeSpawn}
          onClose={() => setShowSettings(false)}
          onChangeDotSize={(n) =>
            setSettings((prev) => ({
              ...prev,
              dotSize: clamp(n, MIN_DOT_SIZE, MAX_DOT_SIZE),
            }))
          }
          onEditArea={enterAreaEditor}
          onResetArea={resetPlayArea}
          onClearLog={clearHistory}
        />
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-white/40">
        {label}
      </span>
      <strong
        className={`text-sm font-semibold ${accent ? "text-white" : "text-white/80"}`}
      >
        {value}
      </strong>
    </span>
  );
}

function SettingsOverlay({
  settings,
  history,
  stats,
  board,
  activeSpawn,
  onClose,
  onChangeDotSize,
  onEditArea,
  onResetArea,
  onClearLog,
}: {
  settings: Settings;
  history: ReactionRecord[];
  stats: { avg: number | null; best: number | null; count: number; misses: number };
  board: { width: number; height: number } | null;
  activeSpawn: Rect | null;
  onClose: () => void;
  onChangeDotSize: (n: number) => void;
  onEditArea: () => void;
  onResetArea: () => void;
  onClearLog: () => void;
}) {
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-black/95 backdrop-blur">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <h2 className="text-base font-semibold">Settings</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-white/10 px-3 py-1.5 text-sm"
        >
          Done
        </button>
      </header>

      <div className="flex-1 overflow-auto px-5 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-8">
          <section>
            <SectionHeader title="Dot size" />
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={MIN_DOT_SIZE}
                max={MAX_DOT_SIZE}
                step={2}
                value={settings.dotSize}
                onChange={(e) => onChangeDotSize(Number(e.target.value))}
                className="flex-1 accent-red-500"
              />
              <div className="w-20 text-right font-mono text-sm tabular-nums">
                {settings.dotSize} px
              </div>
              <div className="flex h-24 w-24 items-center justify-center">
                <div
                  className="rounded-full bg-green-500"
                  style={{
                    width: Math.min(settings.dotSize, 96),
                    height: Math.min(settings.dotSize, 96),
                  }}
                />
              </div>
            </div>
          </section>

          <section>
            <SectionHeader title="Play area" />
            <div className="flex flex-col gap-3">
              <div className="font-mono text-sm text-white/70">
                {settings.playArea ? (
                  <>
                    {settings.playArea.x}, {settings.playArea.y} ·{" "}
                    {settings.playArea.w} × {settings.playArea.h}
                  </>
                ) : (
                  <>Full screen{board ? ` (${board.width} × ${board.height})` : ""}</>
                )}
              </div>
              {activeSpawn && board && (
                <Minimap board={board} rect={activeSpawn} />
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onEditArea}
                  className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black"
                >
                  Edit on screen
                </button>
                {settings.playArea && (
                  <button
                    type="button"
                    onClick={onResetArea}
                    className="rounded-lg border border-white/15 bg-transparent px-4 py-2 text-sm"
                  >
                    Reset to full screen
                  </button>
                )}
              </div>
            </div>
          </section>

          <section>
            <SectionHeader title="Reaction log" />
            <div className="mb-3 flex items-center gap-4 text-xs tabular-nums text-white/60">
              <span>n {stats.count}</span>
              <span>avg {stats.avg !== null ? `${stats.avg} ms` : "—"}</span>
              <span>best {stats.best !== null ? `${stats.best} ms` : "—"}</span>
              <span>misses {stats.misses}</span>
              <span className="ml-auto">
                {confirmClear ? (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onClearLog();
                        setConfirmClear(false);
                      }}
                      className="rounded-md bg-red-500 px-3 py-1.5 text-white"
                    >
                      Confirm clear
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmClear(false)}
                      className="rounded-md bg-white/10 px-3 py-1.5"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmClear(true)}
                    disabled={history.length === 0}
                    className="rounded-md bg-white/10 px-3 py-1.5 disabled:opacity-40"
                  >
                    Clear log
                  </button>
                )}
              </span>
            </div>
            {history.length === 0 ? (
              <p className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-white/40">
                No reactions yet.
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-white/10">
                <table className="w-full text-left text-sm tabular-nums">
                  <thead className="bg-white/5 text-xs uppercase tracking-wider text-white/50">
                    <tr>
                      <th className="px-3 py-2">#</th>
                      <th className="px-3 py-2">Time</th>
                      <th className="px-3 py-2">Reaction</th>
                      <th className="px-3 py-2">Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((r, i) => (
                      <tr
                        key={`${r.id}-${r.at}`}
                        className="border-t border-white/5"
                      >
                        <td className="px-3 py-2 text-white/50">
                          {history.length - i}
                        </td>
                        <td className="px-3 py-2 text-white/70">
                          {fmtTime(r.at)}
                        </td>
                        <td
                          className={`px-3 py-2 font-mono ${r.outcome === "hit" ? "text-white" : "text-red-400"}`}
                        >
                          {r.outcome === "hit"
                            ? `${r.reactionMs} ms`
                            : `miss (${r.reason ?? "?"})`}
                        </td>
                        <td className="px-3 py-2 font-mono text-white/60">
                          {Math.round(r.x)}, {Math.round(r.y)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-white/50">
      {title}
    </h3>
  );
}

function Minimap({
  board,
  rect,
}: {
  board: { width: number; height: number };
  rect: Rect;
}) {
  const maxW = 280;
  const maxH = 180;
  const scale = Math.min(maxW / board.width, maxH / board.height);
  const w = board.width * scale;
  const h = board.height * scale;
  return (
    <div
      className="relative rounded border border-white/10 bg-white/[0.03]"
      style={{ width: w, height: h }}
    >
      <div
        className="absolute rounded-sm border border-emerald-400 bg-emerald-400/15"
        style={{
          left: rect.x * scale,
          top: rect.y * scale,
          width: rect.w * scale,
          height: rect.h * scale,
        }}
      />
    </div>
  );
}
