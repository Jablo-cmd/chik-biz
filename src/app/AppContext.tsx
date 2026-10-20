import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DomainError, type Ctx } from '../domain/commands';
import { formatDate, formatMoney, formatQty, todayISO } from '../domain/format';
import type { AppState, Cents, ISODate } from '../domain/types';
import { LocalDemoStore, memoryStorage, newId, type StorageLike } from '../data/store';

export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info';
  message: string;
}

interface AppContextValue {
  state: AppState;
  store: LocalDemoStore;
  /**
   * Run a command. Returns true on success. Domain errors are returned as a
   * message (and not persisted); unexpected errors are reported as a toast.
   */
  run: (fn: (s: AppState, ctx: Ctx) => AppState, success?: string) => { ok: true } | { ok: false; error: string };
  toast: (kind: Toast['kind'], message: string) => void;
  toasts: Toast[];
  dismissToast: (id: string) => void;
  money: (c: Cents) => string;
  qty: (n: number) => string;
  date: (d: ISODate) => string;
  today: ISODate;
}

const AppCtx = createContext<AppContextValue | null>(null);

function browserStorage(): StorageLike {
  try {
    const k = '__chik_biz_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    return memoryStorage();
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<LocalDemoStore | null>(null);
  if (!storeRef.current) storeRef.current = new LocalDemoStore(browserStorage());
  const store = storeRef.current;
  const [state, setState] = useState<AppState>(() => store.load());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [today, setToday] = useState(todayISO());

  useEffect(() => store.subscribe(setState), [store]);

  // Keep multiple open tabs consistent.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith('chik-biz:')) store.refreshFromStorage();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store]);

  // Roll the business date over if the app is left open past midnight.
  useEffect(() => {
    const t = window.setInterval(() => setToday(todayISO()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const dismissToast = useCallback((id: string) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (kind: Toast['kind'], message: string) => {
      const id = newId();
      setToasts((ts) => [...ts.slice(-3), { id, kind, message }]);
      window.setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 4000);
    },
    [dismissToast],
  );

  const run = useCallback<AppContextValue['run']>(
    (fn, success) => {
      try {
        store.apply((s) => fn(s, { now: new Date(), newId }));
        if (success) toast('success', success);
        return { ok: true };
      } catch (e) {
        if (e instanceof DomainError) return { ok: false, error: e.message };
        const message = e instanceof Error ? e.message : 'Something went wrong.';
        console.error(e);
        toast('error', message);
        return { ok: false, error: message };
      }
    },
    [store, toast],
  );

  const { currency, locale } = state.settings;
  const value = useMemo<AppContextValue>(
    () => ({
      state,
      store,
      run,
      toast,
      toasts,
      dismissToast,
      money: (c) => formatMoney(c, currency, locale),
      qty: (n) => formatQty(n, locale),
      date: (d) => formatDate(d, locale),
      today,
    }),
    [state, store, run, toast, toasts, dismissToast, currency, locale, today],
  );

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): AppContextValue {
  const v = useContext(AppCtx);
  if (!v) throw new Error('useApp must be used inside AppProvider');
  return v;
}
