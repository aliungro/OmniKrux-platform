const registrations = new WeakMap<HTMLElement, { focus: () => boolean }>();

export function registerSelectedRowFocus(grid: HTMLElement, focus: () => boolean): () => void {
  const registration = { focus };
  registrations.set(grid, registration);
  return () => {
    if (registrations.get(grid) === registration) registrations.delete(grid);
  };
}

export function requestSelectedRowFocus(root: ParentNode): boolean {
  const grid = root instanceof HTMLElement && root.matches('[role="grid"]')
    ? root : root.querySelector<HTMLElement>('[role="grid"]');
  return !!grid?.isConnected && (registrations.get(grid)?.focus() ?? false);
}
