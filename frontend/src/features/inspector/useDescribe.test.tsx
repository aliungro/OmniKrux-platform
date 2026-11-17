import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { describeBody } from "../../test/describe";
import { useDescribe } from "./useDescribe";

afterEach(() => vi.unstubAllGlobals());

it.each([undefined, "old-uid"])(
  "guarded Describe never reuses an unguarded or different-UID response (previous UID: %s)",
  async (previousUid) => {
    const url = "/api/clusters/c1/pods/payments/payments-api-1/describe";
    const previous = describeBody({ labels: { instance: "old" } });
    const current = describeBody({ labels: { instance: "current" } });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(previous))
      .mockResolvedValueOnce(Response.json(current));
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient();
    const { result, rerender } = renderHook(
      ({ uid }) => useDescribe("c1", "payments", "payments-api-1", "1", uid),
      {
        initialProps: { uid: previousUid },
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );

    await waitFor(() => expect(result.current.data).toEqual(previous));
    expect(fetch.mock.calls[0][0]).toBe(previousUid ? `${url}?expected_uid=old-uid` : url);

    rerender({ uid: "current/uid+1" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual(current));
    expect(fetch.mock.calls[1][0]).toBe(`${url}?expected_uid=current%2Fuid%2B1`);
  },
);
