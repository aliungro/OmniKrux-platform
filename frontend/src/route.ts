import { useCallback, useEffect, useState } from "react";

/** What the page shows, kept in the URL's hash so a reload, back and forward keep it. */
export type Route = { view: "resources"; kind: string } | { view: "audit" };

export const DEFAULT_ROUTE: Route = { view: "resources", kind: "pods" };

// The backend's kind keys: a DNS subdomain (kubectl's resource name), or the virtual helm-releases.
const KIND_KEY = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export function isKindKey(key: string): boolean {
  return key.length <= 253 && KIND_KEY.test(key);
}

/** `#kind=<key>` or `#audit`; anything else (or a key no cluster could serve) is the pods view. */
export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (h === "audit") return { view: "audit" };
  const params = new URLSearchParams(h);
  const kind = params.get("kind");
  return kind !== null && isKindKey(kind) ? { view: "resources", kind } : DEFAULT_ROUTE;
}

export function routeHash(r: Route): string {
  return r.view === "audit" ? "#audit" : `#kind=${r.kind}`;
}

function sameRoute(a: Route, b: Route): boolean {
  return a.view === b.view && (a.view === "audit" || a.kind === (b as typeof a).kind);
}

/** The route from the hash; setting it adds a history entry, so back and forward walk your views. */
export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () =>
      setRoute((prev) => {
        const next = parseRoute(window.location.hash);
        return sameRoute(prev, next) ? prev : next;
      });
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);

  const go = useCallback((r: Route) => {
    const hash = routeHash(r);
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    setRoute((prev) => (sameRoute(prev, r) ? prev : r));
  }, []);

  return [route, go];
}
