import type { SupabaseClient } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DomainError } from '../domain/commands';
import { formatDate, formatMoney, formatQty, todayISO } from '../domain/format';
import type { AppState, Cents, ID, ISODate } from '../domain/types';
import { applyAction, type Action } from '../data/actions';
import { LocalDemoStore, memoryStorage, newId, type StorageLike } from '../data/store';
import { callRpc, loadBusinessState, rpcFor, settingsRpc } from '../data/supabase';

export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info';
  message: string;
}

export type RunResult = { ok: true } | { ok: false; error: string };

export interface LiveSession {
  client: SupabaseClient;
  businessId: ID;
  role: 'owner' | 'manager' | 'staff';
  email: string;
  signOut: () => Promise<void>;
}

interface AppContextValue {
  state: AppState;
  mode: 'demo' | 'live';
  /** Present only in demo mode. */
  demoStore: LocalDemoStore | null;
  /** Present only in live mode. */
  live: LiveSession | null;
  /** Leave the current mode and return to the start screen. */
  switchMode: () => void;
  /**
   * Run an action. Domain/validation errors are returned as a message (and
   * nothing is saved); unexpected errors are also shown as a toast.
   */
  run: (action: Action, success?: string) => Promise<RunResult>;
  refresh: () => Promise<void>;
  toast: (kind: Toast['kind'], message: string) => void;
  toasts: Toast[];
  dismissToast: (id: string) => void;
  money: (c: Cents) => string;
  qty: (n: number) => string;
  date: (d: ISODate) => string;
  today: ISODate;
}

const AppCtx = createContext<AppContextValue | null>(null);

export function browserStorage(): StorageLike {
  try {
    const k = '__chik_biz_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    return memoryStorage();
  }
}

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismissToast = useCallback((id: string) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (kind: Toast['kind'], message: string) => {
      const id = newId();
      setToasts((ts) => [...ts.slice(-3), { id, kind, message }]);
      window.setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 4000);
    },
    [dismissToast],
  );
  return { toasts, toast, dismissToast };
}

function useToday() {
  const [today, setToday] = useState(todayISO());
  // Roll the business date over if the app is left open past midnight.
  useEffect(() => {
    const t = window.setInterval(() => setToday(todayISO()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return today;
}

function errorResult(e: unknown, toast: (k: Toast['kind'], m: string) => void): RunResult {
  if (e instanceof DomainError) return { ok: false, error: e.message };
  const message = e instanceof Error ? e.message : 'Something went wrong.';
  console.error(e);
  toast('error', message);
  return { ok: false, error: message };
}

function Provider({
  state,
  mode,
  demoStore,
  live,
  run,
  refresh,
  switchMode,
  toasts,
  toast,
  dismissToast,
  today,
  children,
}: Omit<AppContextValue, 'money' | 'qty' | 'date'> & { children: ReactNode }) {
  const { currency, locale } = state.settings;
  const value = useMemo<AppContextValue>(
    () => ({
      state,
      mode,
      demoStore,
      live,
      switchMode,
      run,
      refresh,
      toast,
      toasts,
      dismissToast,
      money: (c) => formatMoney(c, currency, locale),
      qty: (n) => formatQty(n, locale),
      date: (d) => formatDate(d, locale),
      today,
    }),
    [state, mode, demoStore, live, switchMode, run, refresh, toast, toasts, dismissToast, currency, locale, today],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

/** Demo mode: fictional data in this browser's local storage. */
export function DemoProvider({ children, onSwitchMode }: { children: ReactNode; onSwitchMode: () => void }) {
  const storeRef = useRef<LocalDemoStore | null>(null);
  if (!storeRef.current) storeRef.current = new LocalDemoStore(browserStorage());
  const store = storeRef.current;
  const [state, setState] = useState<AppState>(() => store.load());
  const { toasts, toast, dismissToast } = useToasts();
  const today = useToday();

  useEffect(() => store.subscribe(setState), [store]);

  // Keep multiple open tabs consistent.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith('chik-biz:demo')) store.refreshFromStorage();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store]);

  const run = useCallback(
    async (action: Action, success?: string): Promise<RunResult> => {
      try {
        store.apply((s) => applyAction(s, action, { now: new Date(), newId }));
        if (success) toast('success', success);
        return { ok: true };
      } catch (e) {
        return errorResult(e, toast);
      }
    },
    [store, toast],
  );
  const refresh = useCallback(async () => store.refreshFromStorage(), [store]);

  return (
    <Provider
      state={state}
      mode="demo"
      demoStore={store}
      live={null}
      run={run}
      refresh={refresh}
      switchMode={onSwitchMode}
      toasts={toasts}
      toast={toast}
      dismissToast={dismissToast}
      today={today}
    >
      {children}
    </Provider>
  );
}

/** Live mode: the signed-in user's business in Supabase. */
export function LiveProvider({
  session,
  initialState,
  children,
  onSwitchMode,
}: {
  session: LiveSession;
  initialState: AppState;
  children: ReactNode;
  onSwitchMode: () => void;
}) {
  const [state, setState] = useState<AppState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const { toasts, toast, dismissToast } = useToasts();
  const today = useToday();

  const refresh = useCallback(async () => {
    try {
      setState(await loadBusinessState(session.client, session.businessId));
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not refresh data.');
    }
  }, [session, toast]);

  // Pick up changes made on other devices when the user comes back to the app.
  useEffect(() => {
    const onFocus = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, [refresh]);

  const run = useCallback(
    async (action: Action, success?: string): Promise<RunResult> => {
      try {
        // Same validation as the demo, against the latest snapshot, for instant feedback.
        const validated = applyAction(stateRef.current, action, { now: new Date(), newId });
        const { fn, args } =
          action.type === 'updateSettings'
            ? settingsRpc(session.businessId, validated.settings)
            : rpcFor(session.businessId, action);
        // The database re-validates, locks the affected rows and records the change.
        await callRpc(session.client, fn, args);
        setState(await loadBusinessState(session.client, session.businessId));
        if (success) toast('success', success);
        return { ok: true };
      } catch (e) {
        return errorResult(e, toast);
      }
    },
    [session, toast],
  );

  return (
    <Provider
      state={state}
      mode="live"
      demoStore={null}
      live={session}
      run={run}
      refresh={refresh}
      switchMode={onSwitchMode}
      toasts={toasts}
      toast={toast}
      dismissToast={dismissToast}
      today={today}
    >
      {children}
    </Provider>
  );
}

export function useApp(): AppContextValue {
  const v = useContext(AppCtx);
  if (!v) throw new Error('useApp must be used inside a data provider');
  return v;
}
