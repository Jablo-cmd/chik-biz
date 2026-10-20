// Minimal hash router. Hash routing works on static hosts such as GitHub Pages
// without any server-side rewrite rules.

import { useEffect, useState } from 'react';

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = hash.split('?');
  const clean = path.startsWith('/') ? path : `/${path}`;
  return { path: clean, segments: clean.split('/').filter(Boolean), query: new URLSearchParams(qs) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      window.scrollTo(0, 0);
    };
    const onQuery = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    window.addEventListener('chik:query', onQuery);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('chik:query', onQuery);
    };
  }, []);
  return route;
}

export function navigate(href: string) {
  window.location.hash = href.replace(/^#/, '');
}

/** Update query params without adding history entries. */
export function setQuery(params: Record<string, string>) {
  const r = parse();
  const q = new URLSearchParams(r.query);
  for (const [k, v] of Object.entries(params)) {
    if (v) q.set(k, v);
    else q.delete(k);
  }
  const qs = q.toString();
  history.replaceState(null, '', `#${r.path}${qs ? `?${qs}` : ''}`);
  window.dispatchEvent(new Event('chik:query'));
}
