/**
 * Service worker for RougeChain Wallet Extension
 * Handles auto-lock timer, badge updates, and dApp connection messages
 */

interface ConnectedSite {
    origin: string;
    connectedAt: number;
}

// ─── Auto-lock ───────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "auto-lock") {
        chrome.storage.local.remove("pqc-unified-wallet");
    }
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "popup") {
        chrome.storage.local.get("pqc-unified-wallet-vault-settings", (data) => {
            const settings = data["pqc-unified-wallet-vault-settings"];
            let minutes = 5;
            if (settings) {
                try {
                    const parsed = JSON.parse(settings);
                    minutes = parsed.autoLockMinutes || 5;
                } catch { /* use default */ }
            }
            chrome.alarms.clear("auto-lock");
            chrome.alarms.create("auto-lock", { delayInMinutes: minutes });
        });

        port.onDisconnect.addListener(() => {
            // Popup closed — alarm continues running
        });
    }
});

// ─── Install handler ─────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    console.log("RougeChain Wallet Extension installed");
});

// ─── dApp message handler ────────────────────────────────

function getConnectedSites(): Promise<ConnectedSite[]> {
    return new Promise((resolve) => {
        chrome.storage.local.get("rougechain-connected-sites", (data) => {
            const raw = data["rougechain-connected-sites"];
            if (raw) {
                try {
                    resolve(JSON.parse(raw));
                    return;
                } catch { /* fall through */ }
            }
            resolve([]);
        });
    });
}

function saveConnectedSites(sites: ConnectedSite[]): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.local.set({
            "rougechain-connected-sites": JSON.stringify(sites),
        }, resolve);
    });
}

function getWalletData(): Promise<{ publicKey: string; privateKey: string } | null> {
    return new Promise((resolve) => {
        chrome.storage.local.get("pqc-unified-wallet", (data) => {
            const raw = data["pqc-unified-wallet"];
            if (!raw) { resolve(null); return; }
            try {
                const wallet = JSON.parse(raw);
                resolve({
                    publicKey: wallet.signingPublicKey,
                    privateKey: wallet.signingPrivateKey,
                });
            } catch { resolve(null); }
        });
    });
}

function getApiBaseUrl(): Promise<string> {
    return new Promise((resolve) => {
        chrome.storage.local.get(["rougechain-custom-node-url"], (data) => {
            const custom = data["rougechain-custom-node-url"];
            if (custom) {
                let url = custom.replace(/\/+$/, "");
                if (!url.endsWith("/api")) url += "/api";
                resolve(url);
                return;
            }
            resolve("https://testnet.rougechain.io/api");
        });
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "rougechain-request") return false;

    const { method, params, origin } = message;

    (async () => {
        try {
            switch (method) {
                case "connect": {
                    const wallet = await getWalletData();
                    if (!wallet) {
                        sendResponse({ error: "Wallet is locked or not set up" });
                        return;
                    }

                    const sites = await getConnectedSites();
                    const alreadyConnected = sites.some(s => s.origin === origin);

                    if (!alreadyConnected) {
                        sites.push({ origin, connectedAt: Date.now() });
                        await saveConnectedSites(sites);
                    }

                    sendResponse({ result: { publicKey: wallet.publicKey } });
                    break;
                }

                case "getBalance": {
                    const wallet = await getWalletData();
                    if (!wallet) {
                        sendResponse({ error: "Wallet is locked" });
                        return;
                    }

                    const sites = await getConnectedSites();
                    if (!sites.some(s => s.origin === origin)) {
                        sendResponse({ error: "Site not connected. Call connect() first." });
                        return;
                    }

                    const baseUrl = await getApiBaseUrl();
                    const res = await fetch(`${baseUrl}/balance/${wallet.publicKey}`);
                    if (!res.ok) {
                        sendResponse({ error: `Node returned ${res.status}` });
                        return;
                    }
                    const data = await res.json() as {
                        success: boolean;
                        balance: number;
                        token_balances?: Record<string, number>;
                    };

                    sendResponse({
                        result: {
                            balance: data.balance || 0,
                            tokens: data.token_balances || {},
                        },
                    });
                    break;
                }

                case "signTransaction": {
                    const wallet = await getWalletData();
                    if (!wallet) {
                        sendResponse({ error: "Wallet is locked" });
                        return;
                    }

                    const sites = await getConnectedSites();
                    if (!sites.some(s => s.origin === origin)) {
                        sendResponse({ error: "Site not connected" });
                        return;
                    }

                    const payload = params?.payload;
                    if (!payload || typeof payload !== "object") {
                        sendResponse({ error: "Invalid payload" });
                        return;
                    }

                    const signedPayload = JSON.stringify(payload, Object.keys(payload).sort());
                    sendResponse({
                        result: {
                            signedPayload,
                            publicKey: wallet.publicKey,
                        },
                    });
                    break;
                }

                case "sendTransaction": {
                    const wallet = await getWalletData();
                    if (!wallet) {
                        sendResponse({ error: "Wallet is locked" });
                        return;
                    }

                    const sites = await getConnectedSites();
                    if (!sites.some(s => s.origin === origin)) {
                        sendResponse({ error: "Site not connected" });
                        return;
                    }

                    const payload = params?.payload;
                    if (!payload || typeof payload !== "object") {
                        sendResponse({ error: "Invalid payload" });
                        return;
                    }

                    const baseUrl = await getApiBaseUrl();
                    const txPayload = {
                        ...payload as Record<string, unknown>,
                        from: wallet.publicKey,
                        timestamp: Date.now(),
                        nonce: crypto.randomUUID(),
                    };

                    const res = await fetch(`${baseUrl}/v2/tx/submit`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            payload: txPayload,
                            signature: "",
                            public_key: wallet.publicKey,
                        }),
                    });

                    const data = await res.json();
                    if (data.success) {
                        sendResponse({ result: { txId: data.txId || data.tx_id } });
                    } else {
                        sendResponse({ error: data.error || "Transaction failed" });
                    }
                    break;
                }

                default:
                    sendResponse({ error: `Unknown method: ${method}` });
            }
        } catch (err: any) {
            sendResponse({ error: err.message || "Internal error" });
        }
    })();

    return true; // keep the message channel open for async response
});
