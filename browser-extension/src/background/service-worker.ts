/**
 * Service worker for RougeChain Wallet Extension
 * Handles auto-lock timer and badge updates
 */

// Auto-lock alarm
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "auto-lock") {
        // Remove the decrypted wallet from storage
        chrome.storage.local.remove("pqc-unified-wallet");
    }
});

// Reset auto-lock timer on popup open
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "popup") {
        // Get auto-lock settings
        chrome.storage.local.get("pqc-unified-wallet-vault-settings", (data) => {
            const settings = data["pqc-unified-wallet-vault-settings"];
            let minutes = 5;
            if (settings) {
                try {
                    const parsed = JSON.parse(settings);
                    minutes = parsed.autoLockMinutes || 5;
                } catch { /* use default */ }
            }
            // Clear existing alarm and set new one
            chrome.alarms.clear("auto-lock");
            chrome.alarms.create("auto-lock", { delayInMinutes: minutes });
        });

        port.onDisconnect.addListener(() => {
            // Popup closed — alarm continues running
        });
    }
});

// Install handler
chrome.runtime.onInstalled.addListener(() => {
    console.log("RougeChain Wallet Extension installed");
});
