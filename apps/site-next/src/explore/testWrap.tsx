// Shared providers for workspace tests (network data is stubbed to the saved snapshot).
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { WalletProvider } from "../wallet/WalletProvider";
import { NetworkProvider } from "../Network";
export function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unavailable")));
  return render(
    <QueryClientProvider client={client}>
      <WalletProvider autoRegister={false}>
        <NetworkProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </NetworkProvider>
      </WalletProvider>
    </QueryClientProvider>,
  );
}
/** Pretend the viewport is desktop (>= 900px) or phone for WorkspaceExperience. */
export function setDesktop(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}
