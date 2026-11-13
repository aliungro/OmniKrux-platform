import type { QueryClient } from "@tanstack/react-query";
import type { Cluster } from "./types";

type RemovalListener = (id: string) => void;

class ClusterLifecycle {
  private order = 0;
  private readonly removed = new Map<string, number>();
  private readonly lastRemoval = new Map<string, number>();
  private readonly listeners = new Set<RemovalListener>();
  private readonly addListeners = new Set<RemovalListener>();
  private registered = new Set<string>();

  startChange(): number {
    return ++this.order;
  }

  remove(id: string, confirmed = false): boolean {
    if (this.removed.has(id)) return false;
    const removedAt = this.startChange();
    if (!confirmed) this.removed.set(id, removedAt);
    this.lastRemoval.set(id, removedAt);
    for (const listener of this.listeners) listener(id);
    return true;
  }

  isRemoved(id: string): boolean {
    return this.removed.has(id);
  }

  wasRemovedSince(id: string, started: number): boolean {
    return (this.lastRemoval.get(id) ?? 0) > started;
  }

  reconcile(registry: Cluster[], started: number): Cluster[] {
    const present = new Set(registry.map(cluster => cluster.id));
    // A disconnected watch can miss a removal. Use response time for in-flight dock actions.
    for (const id of this.registered) if (!present.has(id)) this.remove(id, true);
    for (const [id, removedAt] of this.removed) {
      if (started > removedAt && !present.has(id)) this.removed.delete(id);
    }
    const visible = this.removed.size ? registry.filter(cluster => !this.isRemoved(cluster.id)) : registry;
    this.registered = new Set(visible.map(cluster => cluster.id));
    return visible;
  }

  added(ids: readonly string[], started: number): void {
    for (const id of ids) {
      const removedAt = this.removed.get(id);
      if (removedAt !== undefined && started > removedAt) {
        this.removed.delete(id);
        for (const listener of this.addListeners) listener(id);
      }
    }
  }

  subscribe(listener: RemovalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeToAdds(listener: RemovalListener): () => void {
    this.addListeners.add(listener);
    return () => this.addListeners.delete(listener);
  }
}

const clients = new WeakMap<QueryClient, ClusterLifecycle>();

export function clusterLifecycle(client: QueryClient): ClusterLifecycle {
  let lifecycle = clients.get(client);
  if (!lifecycle) {
    lifecycle = new ClusterLifecycle();
    clients.set(client, lifecycle);
  }
  return lifecycle;
}
