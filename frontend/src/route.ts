// The backend's kind keys: a DNS subdomain (kubectl's resource name), or the virtual helm-releases.
const KIND_KEY = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export function isKindKey(key: string): boolean {
  return key.length <= 253 && KIND_KEY.test(key);
}

export type HashTarget = { app: import("./features/shell/workspace").AppId; tab?: string } | { legacyKind: string } | null;
export function parseHash(hash: string): HashTarget {
  if (hash === "#audit" || hash === "#/audit") return { app: "audit" };
  if (hash === "#/settings") return { app: "settings" };
  if (hash === "#/kubernetes") return { app: "kubernetes" };
  const tab = /^#\/kubernetes\/([^/]+)$/.exec(hash);
  if (tab) { try { return { app: "kubernetes", tab: decodeURIComponent(tab[1]) }; } catch { return null; } }
  const kind = /^#kind=(.+)$/.exec(hash);
  if (kind && isKindKey(kind[1])) return { legacyKind: kind[1] };
  return null;
}
export function hashFor(app: import("./features/shell/workspace").AppId, tabId?: string): string {
  return `#/${app}${app === "kubernetes" && tabId ? `/${encodeURIComponent(tabId)}` : ""}`;
}
