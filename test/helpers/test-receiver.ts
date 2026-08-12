import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal local webhook receiver for integration tests (ARCHITECTURE.md
 * section 29). It records the raw bytes and headers of every request it
 * receives so a test can verify a signature against exactly what was
 * transmitted, and lets the test decide each response.
 *
 * This is test scaffolding, not a product feature, and deliberately stays
 * small. The demo receiver of Part 7 is a separate concern.
 */

export interface ReceivedRequest {
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly rawBody: Buffer;
}

export type ReceiverResponder = (request: ReceivedRequest, res: http.ServerResponse) => void;

export interface TestReceiver {
  readonly received: ReceivedRequest[];
  url(path: string): string;
  /** Clears the request log so each test asserts only on its own traffic. */
  reset(): void;
  close(): Promise<void>;
}

export async function startTestReceiver(respond: ReceiverResponder): Promise<TestReceiver> {
  const received: ReceivedRequest[] = [];

  const server = http.createServer((req, res) => {
    // A test deliberately aborts a request at the delivery timeout, after
    // which writing the late response raises on a destroyed socket. Swallow
    // it here so the receiver never crashes the test process.
    req.on("error", () => undefined);
    res.on("error", () => undefined);

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request: ReceivedRequest = {
        path: req.url ?? "",
        headers: req.headers,
        rawBody: Buffer.concat(chunks),
      };
      received.push(request);
      respond(request, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    received,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    reset: () => {
      received.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Node's fetch keeps connections alive, so close() alone would hang.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** A port with nothing listening on it, for exercising connection refusal. */
export async function reserveClosedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
