import { afterEach, describe, expect, it, vi } from "vitest";
import { saveJsonFile } from "./download";

afterEach(() => vi.restoreAllMocks());

describe("saveJsonFile", () => {
  it("saving a file clicks a download link and revokes it", async () => {
    const create = vi.fn(() => "blob:fake-1");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
      expect(document.body.contains(this)).toBe(true);
    });
    saveJsonFile("shop.omnikrux.json", { formatVersion: 1, name: "Shop" });
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("shop.omnikrux.json");
    expect(clicked[0].href).toBe("blob:fake-1");
    expect(document.body.contains(clicked[0])).toBe(false);
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe("application/json");
    const text = await blob.text();
    expect(text).toBe('{\n  "formatVersion": 1,\n  "name": "Shop"\n}\n');
    // Revoked on the next task, not before the click has started the download.
    expect(revoke).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5));
    expect(revoke).toHaveBeenCalledWith("blob:fake-1");
  });
});
