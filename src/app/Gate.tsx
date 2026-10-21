// Chooses between demo mode (browser storage) and live mode (Supabase), and
// handles sign-in and first-time business setup for live mode.

import type { Session } from '@supabase/supabase-js';
import { Bird, Database, FlaskConical, LogOut } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AppState } from '../domain/types';
import { callRpc, getSupabase, loadBusinessState, myMemberships, supabaseConfigured } from '../data/supabase';
import { Button, ErrorBanner, TextInput } from '../ui/components';
import { DemoProvider, LiveProvider, browserStorage, type LiveSession } from './AppContext';

type Mode = 'demo' | 'live' | null;
const MODE_KEY = 'chik-biz:mode';

function readMode(): Mode {
  if (!supabaseConfigured) return 'demo';
  try {
    const m = browserStorage().getItem(MODE_KEY);
    return m === 'demo' || m === 'live' ? m : null;
  } catch {
    return null;
  }
}

function writeMode(m: Mode) {
  try {
    if (m) browserStorage().setItem(MODE_KEY, m);
    else browserStorage().removeItem(MODE_KEY);
  } catch {
    // Not persisting the choice is harmless.
  }
}

export function Gate({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(readMode);
  const setMode = useCallback((m: Mode) => {
    writeMode(m);
    setModeState(m);
    window.location.hash = '/';
  }, []);

  if (mode === 'demo') {
    return <DemoProvider onSwitchMode={() => setMode(supabaseConfigured ? null : 'demo')}>{children}</DemoProvider>;
  }
  if (mode === 'live') return <LiveGate onSwitchMode={() => setMode(null)}>{children}</LiveGate>;
  return <Welcome onChoose={setMode} />;
}

function AuthShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-card card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true"><Bird size={20} /></span>
          <div>
            <h1>Chik-Biz</h1>
            <p className="muted small">Poultry business management</p>
          </div>
        </div>
        {children}
      </div>
      <p className="auth-foot">{footer ?? 'Technology provider: Auris Nexus Technologies (Pty) Ltd'}</p>
    </div>
  );
}

function Welcome({ onChoose }: { onChoose: (m: Mode) => void }) {
  return (
    <AuthShell>
      <div className="choice-list">
        <button type="button" className="choice" onClick={() => onChoose('live')}>
          <Database size={22} aria-hidden="true" />
          <span>
            <strong>Sign in to your business</strong>
            <span className="muted small">Live data saved securely in the business database.</span>
          </span>
        </button>
        <button type="button" className="choice" onClick={() => onChoose('demo')}>
          <FlaskConical size={22} aria-hidden="true" />
          <span>
            <strong>Try the demo</strong>
            <span className="muted small">Fictional sample data, kept only in this browser.</span>
          </span>
        </button>
      </div>
    </AuthShell>
  );
}

type LiveStatus =
  | { kind: 'loading'; message?: string }
  | { kind: 'signed-out' }
  | { kind: 'recovery' }
  | { kind: 'needs-business'; session: Session }
  | { kind: 'ready'; live: LiveSession; state: AppState }
  | { kind: 'error'; message: string };

function LiveGate({ children, onSwitchMode }: { children: ReactNode; onSwitchMode: () => void }) {
  const sb = getSupabase();
  const [status, setStatus] = useState<LiveStatus>({ kind: 'loading' });

  const signOut = useCallback(async () => {
    await sb.auth.signOut();
  }, [sb]);

  const enter = useCallback(
    async (session: Session | null) => {
      if (!session) return setStatus({ kind: 'signed-out' });
      setStatus({ kind: 'loading', message: 'Loading your business…' });
      try {
        const memberships = await myMemberships(sb, session.user.id);
        if (memberships.length === 0) return setStatus({ kind: 'needs-business', session });
        const m = memberships[0];
        const state = await loadBusinessState(sb, m.businessId);
        setStatus({
          kind: 'ready',
          state,
          live: { client: sb, businessId: m.businessId, role: m.role, email: session.user.email ?? '', signOut },
        });
      } catch (e) {
        setStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Could not load your business.' });
      }
    },
    [sb, signOut],
  );

  useEffect(() => {
    let active = true;
    void sb.auth.getSession().then(({ data }) => { if (active) void enter(data.session); });
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY') setStatus({ kind: 'recovery' });
      else if (event === 'SIGNED_OUT') setStatus({ kind: 'signed-out' });
      else if (event === 'SIGNED_IN') {
        // Defer: supabase-js recommends not awaiting other calls inside this callback.
        window.setTimeout(() => active && void enter(session), 0);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [sb, enter]);

  switch (status.kind) {
    case 'loading':
      return (
        <AuthShell>
          <p className="muted" role="status">{status.message ?? 'Connecting…'}</p>
        </AuthShell>
      );
    case 'error':
      return (
        <AuthShell>
          <ErrorBanner message={status.message} />
          <div className="button-row">
            <Button variant="primary" onClick={() => void sb.auth.getSession().then(({ data }) => enter(data.session))}>Try again</Button>
            <Button icon={<LogOut size={16} />} onClick={() => void signOut()}>Sign out</Button>
            <Button variant="ghost" onClick={onSwitchMode}>Back</Button>
          </div>
        </AuthShell>
      );
    case 'signed-out':
      return <SignIn onBack={onSwitchMode} />;
    case 'recovery':
      return <NewPassword onDone={() => void sb.auth.getSession().then(({ data }) => enter(data.session))} />;
    case 'needs-business':
      return <CreateBusiness session={status.session} onCreated={() => void enter(status.session)} onSignOut={() => void signOut()} />;
    case 'ready':
      return (
        <LiveProvider session={status.live} initialState={status.state} onSwitchMode={onSwitchMode}>
          {children}
        </LiveProvider>
      );
  }
}

function SignIn({ onBack }: { onBack: () => void }) {
  const sb = getSupabase();
  const [view, setView] = useState<'sign-in' | 'sign-up' | 'reset'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const friendly = (e: { message: string; name?: string; status?: number }) =>
    e.name === 'AuthRetryableFetchError' || /fetch|network/i.test(e.message)
      ? 'Could not reach the server. Check your internet connection and try again.'
      : e.message === 'Invalid login credentials'
        ? 'Email or password is incorrect.'
        : e.message;

  const submit = async () => {
    setError(null);
    setInfo(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Enter a valid email address.');
    if (view !== 'reset' && password.length < 8) return setError('Password must be at least 8 characters.');
    setBusy(true);
    try {
      if (view === 'sign-in') {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
        if (error) setError(friendly(error));
      } else if (view === 'sign-up') {
        const { data, error } = await sb.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirectTo } });
        if (error) setError(friendly(error));
        else if (!data.session) setInfo('Account created. Check your email to confirm your address, then sign in.');
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo });
        if (error) setError(friendly(error));
        else setInfo('If an account exists for that email, a password reset link has been sent.');
      }
    } catch {
      setError('Could not reach the server. Check your internet connection.');
    } finally {
      setBusy(false);
    }
  };

  const title = view === 'sign-in' ? 'Sign in' : view === 'sign-up' ? 'Create an account' : 'Reset password';
  return (
    <AuthShell>
      <h2 className="auth-title">{title}</h2>
      <form className="form-grid one" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <ErrorBanner message={error} />
        {info && <div className="alert alert-info" role="status">{info}</div>}
        <TextInput label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        {view !== 'reset' && (
          <TextInput
            label="Password"
            type="password"
            autoComplete={view === 'sign-up' ? 'new-password' : 'current-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={view === 'sign-up' ? 'At least 8 characters.' : undefined}
          />
        )}
        <Button type="submit" variant="primary" className="block" disabled={busy}>
          {busy ? 'Please wait…' : title}
        </Button>
      </form>
      <div className="auth-links">
        {view !== 'sign-in' && <button type="button" className="text-link" onClick={() => setView('sign-in')}>Sign in instead</button>}
        {view !== 'sign-up' && <button type="button" className="text-link" onClick={() => setView('sign-up')}>Create an account</button>}
        {view === 'sign-in' && <button type="button" className="text-link" onClick={() => setView('reset')}>Forgot password?</button>}
        <button type="button" className="text-link" onClick={onBack}>Back</button>
      </div>
    </AuthShell>
  );
}

function NewPassword({ onDone }: { onDone: () => void }) {
  const sb = getSupabase();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    setBusy(true);
    const { error } = await sb.auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(error.message);
    onDone();
  };
  return (
    <AuthShell>
      <h2 className="auth-title">Choose a new password</h2>
      <form className="form-grid one" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <ErrorBanner message={error} />
        <TextInput label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        <Button type="submit" variant="primary" className="block" disabled={busy}>Save password</Button>
      </form>
    </AuthShell>
  );
}

function CreateBusiness({ session, onCreated, onSignOut }: { session: Session; onCreated: () => void; onSignOut: () => void }) {
  const sb = getSupabase();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return setError('Enter the business name.');
    setBusy(true);
    try {
      await callRpc(sb, 'create_business', { p_name: name.trim() });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the business.');
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      <h2 className="auth-title">Set up your business</h2>
      <p className="muted">Signed in as {session.user.email}. You are not linked to a business yet. Create one to start recording sales and stock — you will be its owner.</p>
      <form className="form-grid one" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <ErrorBanner message={error} />
        <TextInput label="Business name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
        <Button type="submit" variant="primary" className="block" disabled={busy}>{busy ? 'Creating…' : 'Create business'}</Button>
      </form>
      <p className="muted small mt">
        Joining an existing business instead? Ask its owner to add you — staff invitations are not yet available in this version.
      </p>
      <div className="auth-links">
        <button type="button" className="text-link" onClick={onSignOut}>Sign out</button>
      </div>
    </AuthShell>
  );
}
