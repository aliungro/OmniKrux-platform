/** The console's own WebSocket address for `path` (wss when the page is https). */
export function wsUrl(path: string, params: URLSearchParams): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}?${params.toString()}`;
}

/** What the server's socket refused, for the words of a refusal. */
export type SocketRequest = "shell" | "log";

const AGAIN: Record<SocketRequest, string> = { shell: "Open the shell again", log: "Open the logs again" };

/**
 * Plain words for a close the server sends without a message of its own: a refused request
 * (1008), a cross-origin page (4403), or an unknown cluster (4404). Null for any other code.
 */
export function refusalWords(code: number, request: SocketRequest): string | null {
  switch (code) {
    case 1008:
      return `The console turned down this ${request} request. ${AGAIN[request]} from the pod.`;
    case 4403:
      return "The console refused the connection from this page. Open the console from its own address.";
    case 4404:
      return "Unknown cluster. It may have been removed from the kubeconfig; pick it again from the list.";
    default:
      return null;
  }
}

/** Whether opening the socket again could help after it closed with `code`. */
export function canRetryAfterClose(code: number): boolean {
  return code !== 1008 && code !== 4403;
}
