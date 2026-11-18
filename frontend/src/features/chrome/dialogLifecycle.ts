const roots = new Map<HTMLElement, symbol>();
const opened = new Set<() => void>();
const closed = new Set<() => void>();
let generation = 0;

export function onDialogOpened(listener: () => void): () => void {
  opened.add(listener);
  return () => { opened.delete(listener); };
}

export function onLastDialogClosed(listener: () => void): () => void {
  closed.add(listener);
  return () => { closed.delete(listener); };
}

export function registerDialogRoot(root: HTMLElement): () => void {
  const registration = Symbol();
  roots.set(root, registration);
  generation++;
  opened.forEach(listener => listener());
  return () => {
    if (roots.get(root) !== registration) return;
    roots.delete(root);
    if (roots.size) return;
    const closing = ++generation;
    // React may mount a replacement or replay this effect in the same commit.
    queueMicrotask(() => {
      if (closing === generation && !document.querySelector('[aria-modal="true"]')) {
        closed.forEach(listener => listener());
      }
    });
  };
}
