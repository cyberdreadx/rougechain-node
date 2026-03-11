/**
 * Service worker for RougeChain Wallet Extension
 * Handles auto-lock timer, badge updates, and dApp connection messages.
 * Opens approval popup windows for connect/sign/send requests.
 */

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

interface ConnectedSite {
    origin: string;
    connectedAt: number;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function signPayload(payloadJson: string, privateKeyHex: string): string {
    const messageBytes = new TextEncoder().encode(payloadJson);
    const secretKey = hexToBytes(privateKeyHex);
    const signature = ml_dsa65.sign(messageBytes, secretKey);
    return bytesToHex(signature);
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

// ─── Storage helpers ─────────────────────────────────────

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

// ─── Approval popup logic ────────────────────────────────

let approvalCounter = 0;

/**
 * Opens the approval popup and waits for the user to approve or deny.
 * Returns `true` if approved, `false` if denied or window closed.
 */
function requestApproval(
    type: "connect" | "sign" | "send",
    origin: string,
    payload?: Record<string, unknown>
): Promise<boolean> {
    return new Promise((resolve) => {
        const requestId = `${Date.now()}-${++approvalCounter}`;

        // Store payload data in session storage for the popup to read
        chrome.storage.session.set({
            [`approval-${requestId}`]: { payload, origin, type },
        });

        // Build the popup URL
        const params = new URLSearchParams({
            id: requestId,
            type,
            origin,
        });

        // Open approval popup window
        chrome.windows.create(
            {
                url: chrome.runtime.getURL(`approval.html?${params.toString()}`),
                type: "popup",
                width: 380,
                height: 520,
                focused: true,
            },
            (win) => {
                const windowId = win?.id;

                // Listen for the response from the popup
                const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
                    const responseKey = `approval-response-${requestId}`;
                    if (changes[responseKey]) {
                        cleanup();
                        const response = changes[responseKey].newValue;
                        resolve(response?.approved === true);
                    }
                };

                // Listen for window close (user closed without clicking)
                const windowListener = (closedWindowId: number) => {
                    if (closedWindowId === windowId) {
                        // Give a brief moment for storage write to complete
                        setTimeout(() => {
                            chrome.storage.session.get(`approval-response-${requestId}`, (data) => {
                                const response = data[`approval-response-${requestId}`];
                                cleanup();
                                if (response) {
                                    resolve(response.approved === true);
                                } else {
                                    resolve(false); // Window closed = deny
                                }
                            });
                        }, 300);
                    }
                };

                const cleanup = () => {
                    chrome.storage.session.onChanged.removeListener(storageListener);
                    chrome.windows.onRemoved.removeListener(windowListener);
                    // Clean up stored data
                    chrome.storage.session.remove([
                        `approval-${requestId}`,
                        `approval-response-${requestId}`,
                    ]);
                };

                chrome.storage.session.onChanged.addListener(storageListener);
                chrome.windows.onRemoved.addListener(windowListener);

                // Timeout after 2 minutes
                setTimeout(() => {
                    cleanup();
                    resolve(false);
                }, 120_000);
            }
        );
    });
}

// ─── dApp message handler ────────────────────────────────

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

                    // Check if already connected — skip approval
                    const sites = await getConnectedSites();
                    const alreadyConnected = sites.some(s => s.origin === origin);

                    if (!alreadyConnected) {
                        // Open approval popup
                        const approved = await requestApproval("connect", origin);
                        if (!approved) {
                            sendResponse({ error: "User denied connection" });
                            return;
                        }
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

                    // Open approval popup for signing
                    const signApproved = await requestApproval("sign", origin, payload as Record<string, unknown>);
                    if (!signApproved) {
                        sendResponse({ error: "User denied signature request" });
                        return;
                    }

                    const signedPayload = JSON.stringify(payload, Object.keys(payload).sort());
                    const signSig = signPayload(signedPayload, wallet.privateKey);
                    sendResponse({
                        result: {
                            signedPayload,
                            signature: signSig,
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

                    // Open approval popup for transaction
                    const sendApproved = await requestApproval("send", origin, payload as Record<string, unknown>);
                    if (!sendApproved) {
                        sendResponse({ error: "User denied transaction" });
                        return;
                    }

                    const baseUrl = await getApiBaseUrl();
                    const txPayload = {
                        ...payload as Record<string, unknown>,
                        from: wallet.publicKey,
                        timestamp: Date.now(),
                        nonce: crypto.randomUUID(),
                    };

                    const txPayloadJson = JSON.stringify(txPayload, Object.keys(txPayload).sort());
                    const txSig = signPayload(txPayloadJson, wallet.privateKey);

                    const res = await fetch(`${baseUrl}/v2/tx/submit`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            payload: txPayload,
                            signature: txSig,
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
