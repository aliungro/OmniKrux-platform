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
  if (hash === "#/monitoring") return { app: "monitoring" };
  const tab = /^#\/(kubernetes|monitoring)\/([^/]+)$/.exec(hash);
  if (tab) { try { return { app: tab[1] as "kubernetes" | "monitoring", tab: decodeURIComponent(tab[2]) }; } catch { return null; } }
  const kind = /^#kind=(.+)$/.exec(hash);
  if (kind && isKindKey(kind[1])) return { legacyKind: kind[1] };
  return null;
}
export function hashFor(app: import("./features/shell/workspace").AppId, tabId?: string): string {
  return `#/${app}${(app === "kubernetes" || app === "monitoring") && tabId ? `/${encodeURIComponent(tabId)}` : ""}`;
}
