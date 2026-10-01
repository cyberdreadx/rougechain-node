/** Bridge test helpers: an exact-path fetch mock (no real node is ever reached) and a scripted EIP-1193 provider. */
import { vi } from "vitest";

export const API = "http://localhost:5101/api";

export interface Call {
  method: string;
  path: string;
  url: string;
  body: unknown;
}

/**
 * fetch mock keyed by "METHOD /path" (path after the API base, query stripped) or a full URL
 * for third-party hosts (mempool.space). Unmatched requests fail like an offline host.
 */
export function mockApi(routes: Record<string, (body: unknown, url: string) => unknown>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.startsWith(API) ? url.slice(API.length).split("?")[0] : url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, url, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new TypeError(`offline: ${method} ${url}`);
    return new Response(JSON.stringify(handler(body, url)), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls, posts: () => calls.filter((c) => c.method === "POST") };
}

export interface ProviderCall {
  method: string;
  params: unknown;
}

/** A scripted injected wallet: records every request; `handlers` override per method. */
export function mockProvider(handlers: Record<string, (params: unknown[]) => unknown>, chainId = "0x14a34") {
  const calls: ProviderCall[] = [];
  let tx = 0;
  const provider = {
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] | object }) => {
      calls.push({ method, params });
      const p = (Array.isArray(params) ? params : []) as unknown[];
      if (handlers[method]) return handlers[method](p);
      switch (method) {
        case "eth_chainId":
          return chainId;
        case "eth_sendTransaction":
          tx += 1;
          return `0x${String(tx).padStart(64, "a")}`;
        case "eth_getTransactionReceipt":
          return { status: "0x1" };
        case "personal_sign":
          return "0xsig";
        default:
          throw new Error(`unexpected ${method}`);
      }
    }),
  };
  return { provider, calls, sent: () => calls.filter((c) => c.method === "eth_sendTransaction").map((c) => (c.params as unknown[])[0]) };
}

export const instant = () => Promise.resolve();
