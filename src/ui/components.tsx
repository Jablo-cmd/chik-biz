import { X, Search, Inbox, AlertTriangle } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { centsToInput, parseMoney } from '../domain/format';
import type { Cents } from '../domain/types';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode }) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function LinkButton({
  href,
  variant = 'secondary',
  size = 'md',
  icon,
  children,
}: {
  href: string;
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <a href={href} className={`btn btn-${variant} btn-${size}`}>
      {icon}
      <span>{children}</span>
    </a>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, actions, children, className = '', pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2 className="card-title">{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'default', icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad'; icon?: ReactNode }) {
  return (
    <div className={`stat stat-${tone}`}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon && <span className="stat-icon" aria-hidden="true">{icon}</span>}
      </div>
      <div className="stat-value num">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">{icon ?? <Inbox size={28} />}</div>
      <p className="empty-title">{title}</p>
      {children && <p className="empty-text">{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="alert alert-danger" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

// ---------- Form controls ----------

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  required,
  className = '',
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <div className={`field ${error ? 'field-error' : ''} ${className}`}>
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="req" aria-hidden="true"> *</span>}
      </label>
      {children}
      {error ? (
        <p className="field-msg" id={`${htmlFor}-err`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput({ label, hint, error, required, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={rest.id ?? id} required={required} className={className}>
      <input id={rest.id ?? id} className="input" required={required} aria-invalid={!!error} aria-describedby={error ? `${rest.id ?? id}-err` : undefined} {...rest} />
    </Field>
  );
}

export function TextArea({ label, hint, error, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <textarea id={id} className="input" rows={3} aria-invalid={!!error} {...rest} />
    </Field>
  );
}

export function SelectInput({
  label,
  hint,
  error,
  options,
  required,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id} required={required} className={className}>
      <select id={id} className="input" required={required} aria-invalid={!!error} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * Money input that keeps the user's text while typing and reports cents
 * (or null when invalid) to the parent.
 */
export function MoneyInput({
  label,
  value,
  onChange,
  error,
  hint,
  required,
  symbol,
  className,
  id: idProp,
  hideLabel,
}: {
  label: string;
  value: Cents | null;
  onChange: (c: Cents | null, raw: string) => void;
  error?: string | null;
  hint?: ReactNode;
  required?: boolean;
  symbol: string;
  className?: string;
  id?: string;
  hideLabel?: boolean;
}) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const [text, setText] = useState(value === null ? '' : centsToInput(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      // External change (e.g. price auto-filled): sync the text.
      if (value === null ? text !== '' : parseMoney(text) !== value) setText(value === null ? '' : centsToInput(value));
      last.current = value;
    }
  }, [value, text]);
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id} required={required} className={`${className ?? ''} ${hideLabel ? 'label-hidden' : ''}`}>
      <div className="input-affix">
        <span className="affix" aria-hidden="true">{symbol}</span>
        <input
          id={id}
          className="input num"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          aria-invalid={!!error}
          required={required}
          onChange={(e) => {
            setText(e.target.value);
            const c = parseMoney(e.target.value);
            last.current = c;
            onChange(c, e.target.value);
          }}
        />
      </div>
    </Field>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search…', label = 'Search' }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  return (
    <div className="search">
      <Search size={16} aria-hidden="true" />
      <input className="input" type="search" aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string; count?: number }[]; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          className={`tab ${value === t.value ? 'tab-active' : ''}`}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- Dialogs ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal modal-${size}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="modal-inner">
          <div className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">
              <X size={18} />
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  tone = 'danger',
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={tone} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="confirm-msg">{message}</div>
      {children}
    </Modal>
  );
}

// ---------- Misc ----------

export function DateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const idF = useId();
  const idT = useId();
  return (
    <div className="date-range">
      <div className="field-inline">
        <label htmlFor={idF}>From</label>
        <input id={idF} type="date" className="input" value={from} max={to || undefined} onChange={(e) => onChange(e.target.value, to)} />
      </div>
      <div className="field-inline">
        <label htmlFor={idT}>To</label>
        <input id={idT} type="date" className="input" value={to} min={from || undefined} onChange={(e) => onChange(from, e.target.value)} />
      </div>
    </div>
  );
}

export function downloadFile(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  // BOM so spreadsheet apps detect UTF-8 (e.g. "–" in product names).
  const blob = new Blob(['﻿', content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function currencySymbol(currency: string, locale: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

/**
 * Wraps an async submit handler so repeated clicks while it is running are
 * ignored (the server is also idempotent, but this avoids duplicate requests).
 */
export function useSingleFlight() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const guard = async (fn: () => Promise<void> | void) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, guard };
}
