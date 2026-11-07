/** A stand-in for the browser WebSocket in tests: records each socket and lets a test play the server. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no socket was opened");
    return ws;
  }

  readonly url: string;
  readonly params: URLSearchParams;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  /** Set once the page closed this socket. */
  closedByClient = false;

  constructor(url: string) {
    this.url = url;
    this.params = new URL(url).searchParams;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closedByClient = true;
  }

  /** The server sends one JSON message. */
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The connection closes from the server's side (or the network's). */
  drop(code = 1006): void {
    this.onclose?.({ code, reason: "" });
  }
}
