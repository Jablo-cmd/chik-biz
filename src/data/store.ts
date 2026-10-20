// Data access boundary.
//
// The UI never touches persistence directly: it reads an AppState snapshot and
// applies changes through `DataStore.apply(command)`. The demo implementation
// below keeps everything in this browser's localStorage. A production
// implementation would replace it with calls to trusted backend functions
// (see supabase/README.md) without changing the domain rules or the UI.

import { buildDemoState } from '../domain/seed';
import { emptyState } from '../domain/defaults';
import { SCHEMA_VERSION, type AppState } from '../domain/types';

export type Command = (state: AppState) => AppState;

export interface DataStore {
  readonly kind: 'demo-local' | 'backend';
  load(): AppState;
  /**
   * Apply a command against the latest persisted state and persist the result
   * atomically. Returns the new state. Throws if the command throws; in that
   * case nothing is persisted.
   */
  apply(command: Command): AppState;
  replace(state: AppState): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
}

const STORAGE_KEY = 'chik-biz:demo-state:v1';

export function isAppState(x: unknown): x is AppState {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  return (
    s.schemaVersion === SCHEMA_VERSION &&
    typeof s.settings === 'object' &&
    ['products', 'movements', 'batches', 'customers', 'sales', 'payments', 'expenses', 'suppliers', 'purchases', 'audit'].every(
      (k) => Array.isArray(s[k]),
    )
  );
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory fallback, used when localStorage is unavailable (e.g. private mode) and in tests. */
export function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

export class LocalDemoStore implements DataStore {
  readonly kind = 'demo-local' as const;
  private listeners = new Set<(s: AppState) => void>();
  private cache: AppState | null = null;
  private raw: string | null = null;
  /** True when persistence failed and data only lives in memory for this tab. */
  public volatile = false;

  constructor(
    private storage: StorageLike,
    private seed: () => AppState = () => buildDemoState(),
  ) {}

  load(): AppState {
    if (this.volatile && this.cache) return this.cache;
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(STORAGE_KEY);
    } catch {
      this.volatile = true;
    }
    if (raw !== null && raw === this.raw && this.cache) return this.cache;
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isAppState(parsed)) {
          this.cache = parsed;
          this.raw = raw;
          return parsed;
        }
      } catch {
        // fall through to re-seed
      }
    }
    return this.write(this.seed());
  }

  apply(command: Command): AppState {
    // Always start from the latest persisted state so that changes made in
    // another tab are not overwritten.
    const current = this.load();
    const next = command(current);
    if (next === current) return current;
    return this.write(next);
  }

  replace(state: AppState): AppState {
    return this.write(state);
  }

  resetToSample(): AppState {
    return this.write(buildDemoState());
  }

  clearAll(): AppState {
    const current = this.load();
    return this.write(emptyState(current.settings));
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called when another tab changed storage. */
  refreshFromStorage(): void {
    const s = this.load();
    this.listeners.forEach((l) => l(s));
  }

  private write(state: AppState): AppState {
    const raw = JSON.stringify(state);
    try {
      // A single setItem call: the whole new state is stored or none of it.
      this.storage.setItem(STORAGE_KEY, raw);
      this.volatile = false;
    } catch (e) {
      if (e instanceof DOMException && /quota/i.test(e.name)) {
        throw new Error('Browser storage is full. Remove the logo or reset the demo data.');
      }
      this.volatile = true;
    }
    this.cache = state;
    this.raw = raw;
    this.listeners.forEach((l) => l(state));
    return state;
  }
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
