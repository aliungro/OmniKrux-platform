import { beforeEach } from "vitest";
beforeEach(async () => {
  if (typeof window !== "undefined") { window.localStorage.clear(); window.history.replaceState(null, "", "/"); }
  // Load after test-module mocks are registered; the store shares the storage validator's imports.
  const { resetPinnedKinds } = await import("../features/settings/pinnedKinds");
  resetPinnedKinds();
});
