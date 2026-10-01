/**
 * The site-wide gate: a wallet whose private keys no password protects (legacy plaintext from an
 * older build, or a create / import left before its password step) blocks every page until the
 * user sets a password; the plaintext copy is then deleted and only the encrypted vault remains.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it } from "vitest";
import { hasEncryptedWallet, saveUnifiedWallet, unlockUnifiedWallet } from "@rougechain/core/unified-wallet";
import { resetWalletStoreForTests } from "./store";
import { WalletProvider } from "./WalletProvider";
import { SecureWalletGate } from "./SecureWalletGate";
import { Toaster } from "./toast";
import { dumpStorage, mockFetch, resetBrowserState, seedAppsWebLockedWallet, seedAppsWebWallet } from "./test-utils";

function renderGate(path = "/swap") {
  return render(
    <WalletProvider autoRegister={false}>
      <MemoryRouter initialEntries={[path]}>
        <SecureWalletGate>
          <p>Page content</p>
        </SecureWalletGate>
        <Toaster />
      </MemoryRouter>
    </WalletProvider>,
  );
}

beforeEach(() => {
  resetBrowserState();
  mockFetch();
});

it("blocks pages for a legacy plaintext wallet until a password encrypts it (plaintext deleted)", async () => {
  const w = seedAppsWebWallet();
  sessionStorage.clear();
  localStorage.setItem("pqc-unified-wallet:mainnet", JSON.stringify(w)); // older build's plaintext copy
  renderGate();
  expect(await screen.findByRole("heading", { name: "Secure your wallet" })).toBeInTheDocument();
  expect(screen.getByText(/may be stored unencrypted in this browser/)).toBeInTheDocument();
  expect(screen.queryByText("Page content")).toBeNull();

  const user = userEvent.setup();
  // Backup is offered (recovery phrase / encrypted export), without the import tab.
  await user.click(screen.getByRole("button", { name: "Back up first" }));
  const dialog = await screen.findByRole("dialog", { name: "Backup & recovery" }, { timeout: 3000 });
  expect(dialog).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Import" })).toBeNull();
  await user.click(screen.getAllByRole("button", { name: "Close dialog" }).at(-1)!);

  await user.type(screen.getByLabelText("Password"), "short");
  await user.type(screen.getByLabelText("Confirm password"), "short");
  await user.click(screen.getByRole("button", { name: "Encrypt wallet" }));
  expect(screen.getByText("Password must be at least 8 characters")).toBeInTheDocument();
  expect(hasEncryptedWallet()).toBe(false);

  await user.clear(screen.getByLabelText("Password"));
  await user.clear(screen.getByLabelText("Confirm password"));
  await user.type(screen.getByLabelText("Password"), "legacy-pass-1");
  await user.type(screen.getByLabelText("Confirm password"), "legacy-pass-1");
  await user.click(screen.getByRole("button", { name: "Encrypt wallet" }));
  expect(await screen.findByText("Page content", {}, { timeout: 30_000 })).toBeInTheDocument();

  expect(hasEncryptedWallet()).toBe(true);
  expect(localStorage.getItem("pqc-unified-wallet:mainnet")).toBeNull();
  const local = Object.values(dumpStorage(localStorage)).join("\n");
  expect(local).not.toContain(w.signingPrivateKey);
  expect(local).not.toContain(w.encryptionPrivateKey);
  expect(local).not.toContain(w.mnemonic!);
  sessionStorage.clear();
  expect((await unlockUnifiedWallet("legacy-pass-1")).signingPrivateKey).toBe(w.signingPrivateKey);
}, 60_000);

it("a legacy unscoped or v1 split-key wallet survives closing the tab without a password, and is gated again", async () => {
  const w = seedAppsWebWallet();
  const secret = w.signingPrivateKey.slice(-200); // not part of the public key
  const legacyForms: [string, string][] = [
    ["pqc-unified-wallet", JSON.stringify(w)], // pre-network-scoping
    ["pqc_messenger_wallet:mainnet", JSON.stringify({ id: w.id, displayName: "Old", signingPublicKey: w.signingPublicKey, signingPrivateKey: w.signingPrivateKey, encryptionPublicKey: w.encryptionPublicKey, encryptionPrivateKey: w.encryptionPrivateKey })],
    ["pqc-blockchain-wallet:mainnet", JSON.stringify({ publicKey: w.signingPublicKey, privateKey: w.signingPrivateKey, createdAt: 1 })],
  ];
  for (const [key, value] of legacyForms) {
    resetBrowserState();
    mockFetch();
    localStorage.setItem(key, value);
    for (let visit = 0; visit < 2; visit++) {
      const view = renderGate();
      expect(await screen.findByRole("heading", { name: "Secure your wallet" }), key).toBeInTheDocument();
      view.unmount();
      sessionStorage.clear(); // tab closed without setting a password
      resetWalletStoreForTests();
      const onDisk = Object.values(dumpStorage(localStorage)).some((v) => v.includes(secret));
      expect(onDisk, `${key} visit ${visit}: private key still recoverable`).toBe(true);
    }
  }
});

it("does not gate a password-protected wallet, a locked vault, an extension wallet or no wallet", async () => {
  const check = () => {
    const view = renderGate();
    expect(screen.getByText("Page content")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Secure your wallet" })).toBeNull();
    view.unmount();
    resetWalletStoreForTests();
  };
  check(); // no wallet
  await seedAppsWebLockedWallet("vault-pass-1");
  check(); // locked vault
  await unlockUnifiedWallet("vault-pass-1");
  check(); // unlocked vault
  resetBrowserState();
  saveUnifiedWallet({ id: "ext-1", displayName: "Ext", createdAt: 1, signingPublicKey: "ab".repeat(1952), signingPrivateKey: "", encryptionPublicKey: "", encryptionPrivateKey: "", version: 2 });
  check(); // extension wallet (no local keys)
}, 60_000);

it("leaves the /wallet create flow's own password step alone, but gates other pages during it", async () => {
  const { useWallet } = await import("./WalletProvider");
  let create: () => Promise<void> = async () => {};
  function Grab() {
    create = useWallet().create;
    return null;
  }
  const view = render(
    <WalletProvider autoRegister={false}>
      <MemoryRouter initialEntries={["/wallet"]}>
        <Grab />
        <SecureWalletGate>
          <p>Wallet page</p>
        </SecureWalletGate>
      </MemoryRouter>
    </WalletProvider>,
  );
  await act(() => create());
  expect(await screen.findByText("Wallet page")).toBeInTheDocument();
  view.unmount();
  renderGate("/swap"); // new provider: no in-memory flow, staged wallet still in this tab
  expect(await screen.findByText(/Your new wallet isn't saved yet/)).toBeInTheDocument();
  expect(localStorage.getItem("pqc-unified-wallet:mainnet")).toBeNull();
});
