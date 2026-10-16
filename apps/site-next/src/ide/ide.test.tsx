import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ChainProvider } from "../explorer/chain";
import { WalletProvider } from "../wallet/WalletProvider";
import { resetBrowserState } from "../wallet/test-utils";
import { TOUR_SEEN_KEY } from "../wallet/tour";
import { featureHeaderProduct, featureRoutes } from "../features";
import { HOST_FUNCTIONS, analyzeWasm } from "./analyze";
import { TEMPLATES, fillPlaceholders } from "./templates";
import { formatXrge, parseXrge } from "./vm";
import initVm, { LocalChain } from "./vm/quantum_vault_vm_wasm.js";

const repo = path.resolve(__dirname, "../../../..");
const vmWasm = readFileSync(path.join(__dirname, "vm/quantum_vault_vm_wasm_bg.wasm"));
const contract = (dir: string, file: string) => new Uint8Array(readFileSync(path.join(repo, "contracts", dir, file)));

// The page loads the VM through a URL; in tests it comes from the committed file.
vi.mock("./vm", async (importOriginal) => {
  const real = await importOriginal<typeof import("./vm")>();
  return {
    ...real,
    newLocalChain: async () => {
      const mod = await import("./vm/quantum_vault_vm_wasm.js");
      await mod.default({ module_or_path: readFileSync(path.join(__dirname, "vm/quantum_vault_vm_wasm_bg.wasm")) });
      return new mod.LocalChain("rougechain-local-1", 1_760_000_000n);
    },
  };
});

beforeAll(async () => {
  await initVm({ module_or_path: vmWasm });
});

describe("host functions", () => {
  it("match what the node links (core/vm/src/host.rs + game.rs)", () => {
    const src = ["host.rs", "game.rs"].map((f) => readFileSync(path.join(repo, "core/vm/src", f), "utf8")).join("\n");
    const linked = [...src.matchAll(/func_wrap\(\s*"env",\s*"([a-z0-9_]+)"/g)].map((m) => m[1]).sort();
    expect([...HOST_FUNCTIONS].sort()).toEqual(linked);
  });
});

describe("analyzeWasm", () => {
  it("lists a template's methods and finds nothing wrong", async () => {
    const a = await analyzeWasm(contract("counter", "counter.wasm"));
    expect(a.methods).toEqual(["get", "increment"]);
    expect(a.exportsMemory).toBe(true);
    expect(a.problems).toEqual([]);
  });

  it("flags a host function the node doesn't provide (the old ERC-20 template's storage_write)", async () => {
    // (module (import "env" "storage_write" (func (param i32 i32 i32 i32)))
    //         (memory (export "memory") 1) (func (export "call")))
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x0b, 0x02, 0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x00, 0x60, 0x00, 0x00,
      0x02, 0x15, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x0d, ...new TextEncoder().encode("storage_write"), 0x00, 0x00,
      0x03, 0x02, 0x01, 0x01,
      0x05, 0x03, 0x01, 0x00, 0x01,
      0x07, 0x11, 0x02, 0x06, ...new TextEncoder().encode("memory"), 0x02, 0x00, 0x04, ...new TextEncoder().encode("call"), 0x00, 0x01,
      0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
    ]);
    const a = await analyzeWasm(bytes);
    expect(a.methods).toEqual(["call"]);
    expect(a.imports).toEqual([{ module: "env", name: "storage_write", known: false }]);
    expect(a.problems.join(" ")).toMatch(/env::storage_write.*every call fails/);
  });

  it("refuses something that isn't WebAssembly", async () => {
    const a = await analyzeWasm(new TextEncoder().encode("not wasm"));
    expect(a.problems[0]).toMatch(/Not a valid WebAssembly module/);
  });
});

describe("templates", () => {
  it("every template's prebuilt .wasm is clean and its method hints name real methods", async () => {
    for (const t of TEMPLATES) {
      const dir = t.dir.replace("contracts/", "");
      const file = readdirSync(path.join(repo, t.dir)).find((f) => f.endsWith(".wasm"));
      expect(file, t.id).toBeTruthy();
      const a = await analyzeWasm(contract(dir, file!));
      expect(a.problems, t.id).toEqual([]);
      for (const m of Object.keys(t.methods)) expect(a.methods, `${t.id}.${m}`).toContain(m);
    }
  });

  it("fills placeholders and leaves unknown ones", () => {
    expect(fillPlaceholders('{"a":"{{me}}","b":{{token}},"c":"{{x}}"}', { me: "rouge1q", token: "7" })).toBe('{"a":"rouge1q","b":7,"c":"{{x}}"}');
  });
});

describe("XRGE amounts", () => {
  it("convert exactly between XRGE and quanta", () => {
    expect(parseXrge("1.5")).toBe("1500000000");
    expect(parseXrge("0.000000001")).toBe("1");
    expect(parseXrge("2")).toBe("2000000000");
    expect(parseXrge("1.0000000001")).toBeNull();
    expect(parseXrge("-1")).toBeNull();
    expect(formatXrge("1500000000")).toBe("1.5");
    expect(formatXrge("10000000000000")).toBe("10,000");
  });
});

describe("local chain (the node's VM as WebAssembly)", () => {
  it("runs the marketplace sale exactly as on testnet: royalty, seller proceeds, NFT to the buyer", () => {
    const Q = 1_000_000_000n;
    const c = new LocalChain("rougechain-local-1", 1_760_000_000n);
    const alice = c.createAccount((1000n * Q).toString());
    const bob = c.createAccount((1000n * Q).toString());
    const carol = c.createAccount("0");
    const col = c.createCollection(alice.publicKey, "ART", "Art", 10n, 500, carol.address);
    const id = c.mintNft(alice.publicKey, col, alice.publicKey, "Piece #1");
    const m = c.deploy(alice.publicKey, contract("nft_marketplace", "nft_marketplace.wasm"));

    expect(c.call(alice.publicKey, m.address, "list", JSON.stringify({ collection: col, token_id: Number(id), price: 2_000_000_000 })).success).toBe(true);
    c.transferNft(alice.publicKey, col, id, m.address);

    const under = c.call(bob.publicKey, m.address, "buy", '{"listing":1}', "XRGE", Q.toString());
    expect(under.success).toBe(false);
    expect(under.applied).toBe(false);

    const buy = c.call(bob.publicKey, m.address, "buy", '{"listing":1}', "XRGE", (2n * Q).toString());
    expect(buy.success).toBe(true);
    expect(buy.applied).toBe(true);

    const s = c.snapshot();
    const bal = (a: string) => s.xrge.find((x: { address: string }) => x.address === a)?.quanta ?? "0";
    expect(bal(carol.address)).toBe("100000000"); // 5 % royalty
    expect(bal(alice.address)).toBe("1001900000000");
    expect(bal(bob.address)).toBe("998000000000");
    expect(s.nfts[0].ownerAddress).toBe(bob.address);
    expect(c.query(bob.publicKey, m.address, "listing", '{"listing":1}').return_data).toEqual({ listing: 1, exists: false });
  });

  it("refuses a contract the node would refuse (no exported memory)", () => {
    const c = new LocalChain("rougechain-local-1", 1_760_000_000n);
    const a = c.createAccount("0");
    // (module (func (export "f")))
    const noMemory = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 0x66, 0, 0, 0x0a, 4, 1, 2, 0, 0x0b]);
    expect(() => c.deploy(a.publicKey, noMemory)).toThrow(/memory/);
  });
});

describe("IDE page", () => {
  beforeEach(() => {
    // CodeMirror measures text; jsdom has no layout.
    const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => rect as DOMRect;
    resetBrowserState();
    vi.stubGlobal("WebSocket", undefined);
    localStorage.setItem(TOUR_SEEN_KEY, "1");
    // Template builds are fetched by URL; serve them from the repository.
    const wasmFiles = new Map<string, string>();
    for (const t of TEMPLATES) {
      const f = readdirSync(path.join(repo, t.dir)).find((x) => x.endsWith(".wasm"))!;
      wasmFiles.set(f, path.join(repo, t.dir, f));
    }
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const name = url.split("?")[0].split("/").pop() ?? "";
      const file = wasmFiles.get(name);
      if (file) return new Response(readFileSync(file), { headers: { "Content-Type": "application/wasm" } });
      return new Response(JSON.stringify({ success: false }), { status: 404 });
    }));
  });

  function renderIde() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <QueryClientProvider client={client}>
        <ChainProvider>
          <WalletProvider autoRegister={false}>
            <MemoryRouter initialEntries={["/ide"]}>
              <Routes>{featureRoutes}</Routes>
            </MemoryRouter>
          </WalletProvider>
        </ChainProvider>
      </QueryClientProvider>,
    );
  }

  it("is routed at /ide with its own app header", () => {
    expect(featureHeaderProduct("/ide")).toBe("IDE");
  });

  it("deploys the counter template to the local chain and calls it", async () => {
    const user = userEvent.setup();
    renderIde();
    expect(await screen.findByRole("heading", { level: 1, name: "RougeChain IDE" })).toBeInTheDocument();
    const deploy = await screen.findByRole("button", { name: "Deploy to local chain" });
    await waitFor(() => expect(deploy).toBeEnabled());
    expect(screen.getByText("Uses 7 host functions, all provided by the node.")).toBeInTheDocument();

    await user.click(deploy);
    expect(await screen.findByText("Deployed rougechain_counter.wasm")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^increment/ }));
    await user.click(screen.getByRole("button", { name: "Call" }));
    const entry = (await screen.findByText(/^Call increment on .* as Alice$/)).closest("li")!;
    expect(entry).toHaveClass("ok");
    const returned = within(entry).getByText("returned").nextElementSibling!;
    expect(JSON.parse(returned.textContent!)).toEqual({ count: 1 });
    expect(within(entry).getByText("event incremented")).toBeInTheDocument();
  });
});
