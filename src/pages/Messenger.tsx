import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, Plus, Lock, Key, Settings, Download, RefreshCw, ArrowDownUp, Copy, KeyRound, UserCircle, Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import WalletSetup from "@/components/messenger/WalletSetup";
import ConversationList from "@/components/messenger/ConversationList";
import ChatView from "@/components/messenger/ChatView";
import ContactPicker from "@/components/messenger/ContactPicker";
import PrivacySettings from "@/components/messenger/PrivacySettings";
import SwapWidget from "@/components/messenger/SwapWidget";
import WalletBackup from "@/components/wallet/WalletBackup";
import type { Conversation, Wallet, WalletWithPrivateKeys } from "@/lib/pqc-messenger";
import { getConversations, getWallets, saveWalletLocally, registerWalletOnNode, getBlockedWalletIds, getPrivacySettings } from "@/lib/pqc-messenger";
import {
  UnifiedWallet,
  VaultSettings,
  getVaultSettings,
  saveVaultSettings,
  unlockUnifiedWallet,
  isWalletLocked,
  getLockedWalletMetadata,
  loadUnifiedWallet,
  saveUnifiedWallet,
  toMessengerWallet,
  fromMessengerWallet
} from "@/lib/unified-wallet";
import {
  requestNotificationPermission,
  hasNotificationPermission,
  detectNewActivity,
  loadNotificationSettings,
  saveNotificationSettings,
  type ConversationActivity,
} from "@/lib/notifications";
import { useRougeAddress } from "@/hooks/useRougeAddress";

const Messenger = () => {
  const [wallet, setWallet] = useState<UnifiedWallet | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contacts, setContacts] = useState<Wallet[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [showPrivacySettings, setShowPrivacySettings] = useState(false);
  const [showWalletBackup, setShowWalletBackup] = useState(false);
  const [showSwapWidget, setShowSwapWidget] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isReregistering, setIsReregistering] = useState(false);
  const [isRegeneratingKeys, setIsRegeneratingKeys] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [vaultSettings, setVaultSettings] = useState<VaultSettings>(() => getVaultSettings());
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [promptName, setPromptName] = useState("");
  const [notifEnabled, setNotifEnabled] = useState(() => loadNotificationSettings().enabled);
  const activitySnapshotRef = useRef<Map<string, string>>(new Map());
  const allWalletsRef = useRef<Wallet[]>([]);
  const { display: walletRougeAddr } = useRougeAddress(wallet?.signingPublicKey);

  // Load wallet from localStorage on mount
  useEffect(() => {
    const locked = isWalletLocked();
    setIsLocked(locked);
    const savedWallet = locked ? null : loadUnifiedWallet();
    if (savedWallet) {
      setWallet(savedWallet);
      // Prompt for display name if it's generic or empty
      const name = savedWallet.displayName?.trim() || "";
      const generic = ["my wallet", "wallet", "unnamed", "untitled", ""];
      if (generic.includes(name.toLowerCase())) {
        setShowNamePrompt(true);
      }
    }
    setIsLoading(false);
  }, []);

  // Load conversations when wallet is available and ensure wallet is registered
  useEffect(() => {
    if (wallet) {
      // Only auto-register if user has opted into being discoverable
      const privacySettings = getPrivacySettings();
      if (wallet.encryptionPublicKey && privacySettings.discoverable) {
        registerWalletOnNode({
          id: wallet.id,
          displayName: wallet.displayName,
          signingPublicKey: wallet.signingPublicKey,
          encryptionPublicKey: wallet.encryptionPublicKey,
        }).catch(() => {});
      }
      requestNotificationPermission().catch(() => {});
      loadConversations();
      loadContacts();
      const interval = setInterval(() => {
        loadConversations();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [wallet]);

  useEffect(() => {
    setVaultSettings(getVaultSettings());
  }, []);

  const resolveDisplayName = useCallback((senderId: string): string => {
    const w = allWalletsRef.current.find(w =>
      w.id === senderId || w.signingPublicKey === senderId || w.encryptionPublicKey === senderId
    );
    return w?.displayName || "Someone";
  }, []);

  const loadConversations = async () => {
    if (!wallet) return;
    try {
      const convs = await getConversations(wallet.id, toMessengerWallet(wallet) as Parameters<typeof getConversations>[1]);
      const blocked = new Set(getBlockedWalletIds());
      const myIds = new Set([wallet.id, wallet.signingPublicKey, wallet.encryptionPublicKey].filter(Boolean));
      const myWalletData = {
        id: wallet.id,
        displayName: wallet.displayName,
        signingPublicKey: wallet.signingPublicKey,
        encryptionPublicKey: wallet.encryptionPublicKey,
      };
      const filtered: Conversation[] = [];
      for (const conv of convs) {
        if (conv.participants) {
          conv.participants = conv.participants.map(p => {
            if (
              p.id === wallet.id ||
              p.signingPublicKey === wallet.signingPublicKey ||
              p.encryptionPublicKey === wallet.encryptionPublicKey ||
              p.displayName === wallet.displayName
            ) {
              return myWalletData;
            }
            return p;
          });
        }
        const hasBlockedParticipant = conv.participants?.some(p =>
          blocked.has(p.id) || blocked.has(p.signingPublicKey) || blocked.has(p.encryptionPublicKey)
        ) || conv.participantIds?.some(id => blocked.has(id));
        if (!hasBlockedParticipant) filtered.push(conv);
      }

      // Detect new messages and fire notifications
      const activity: ConversationActivity[] = filtered.map(c => ({
        conversationId: c.id,
        lastMessageAt: c.lastMessageAt,
        lastSenderId: c.lastSenderId,
        lastMessagePreview: c.lastMessagePreview,
        unreadCount: c.unreadCount,
      }));
      activitySnapshotRef.current = detectNewActivity(
        activity,
        activitySnapshotRef.current,
        myIds,
        resolveDisplayName,
        (convId) => {
          const conv = filtered.find(c => c.id === convId);
          if (conv) setSelectedConversation(conv);
        }
      );

      filtered.sort((a, b) => {
        const tsA = a.lastMessageAt || a.createdAt || "";
        const tsB = b.lastMessageAt || b.createdAt || "";
        return tsB.localeCompare(tsA);
      });

      setConversations(filtered);
    } catch (error) {
      console.error("Failed to load conversations:", error);
    }
  };

  const loadContacts = async () => {
    try {
      const wallets = await getWallets();
      allWalletsRef.current = wallets;
      const blocked = new Set(getBlockedWalletIds());
      const filtered = wallets.filter(w =>
        w.id !== wallet?.id &&
        w.id !== wallet?.signingPublicKey &&
        w.signingPublicKey !== wallet?.signingPublicKey &&
        w.encryptionPublicKey !== wallet?.encryptionPublicKey &&
        !blocked.has(w.id) && !blocked.has(w.signingPublicKey) && !blocked.has(w.encryptionPublicKey)
      );

      const uniqueMap = new Map<string, typeof filtered[0]>();
      for (const w of filtered) {
        const key = w.signingPublicKey || w.encryptionPublicKey || w.id;
        const existing = uniqueMap.get(key);
        if (!existing ||
          (existing.displayName === "My Wallet" && w.displayName !== "My Wallet") ||
          (!existing.displayName && w.displayName)) {
          uniqueMap.set(key, w);
        }
      }

      setContacts(Array.from(uniqueMap.values()));
    } catch (error) {
      console.error("Failed to load contacts:", error);
    }
  };

  // Convert wallet to messenger format for components
  const messengerWallet = useMemo(() =>
    wallet ? toMessengerWallet(wallet) as WalletWithPrivateKeys : null,
    [wallet]
  );

  const handleWalletCreated = (newWallet: WalletWithPrivateKeys) => {
    const unified = fromMessengerWallet(newWallet);
    saveUnifiedWallet(unified);
    setWallet(unified);
    toast.success("Wallet created!", {
      description: "Your quantum-safe keypairs are ready for both messaging and blockchain",
    });
  };

  const handleConversationCreated = (conversation: Conversation) => {
    setConversations(prev => [...prev, conversation]);
    setSelectedConversation(conversation);
    setShowContactPicker(false);
  };

  const handleWalletImport = (importedWallet: UnifiedWallet) => {
    saveUnifiedWallet(importedWallet);
    // Also save to messenger format for backward compatibility
    saveWalletLocally(toMessengerWallet(importedWallet) as WalletWithPrivateKeys);
    setWallet(importedWallet);
    loadConversations();
  };

  const handleUnlock = async () => {
    if (!unlockPassword.trim()) {
      toast.error("Enter your vault password");
      return;
    }
    setUnlocking(true);
    try {
      await unlockUnifiedWallet(unlockPassword.trim());
      const validated = loadUnifiedWallet();
      if (!validated) throw new Error("Wallet could not be loaded after unlock");
      setWallet(validated);
      setIsLocked(false);
      setUnlockPassword("");
      toast.success("Wallet unlocked");
    } catch (error) {
      console.error("Unlock failed:", error);
      toast.error("Unlock failed", {
        description: "Invalid password or missing vault data",
      });
    } finally {
      setUnlocking(false);
    }
  };

  const handleVaultSettings = (settings: VaultSettings) => {
    saveVaultSettings(settings);
    setVaultSettings(settings);
  };

  const handleReregister = async () => {
    if (!wallet || isReregistering) return;
    const privSettings = getPrivacySettings();
    if (!privSettings.discoverable) {
      toast.info("You are hidden", {
        description: "Enable 'Discoverable' in Privacy Settings to register your wallet on the network",
      });
      return;
    }
    setIsReregistering(true);
    try {
      // Check if wallet has encryption key
      if (!wallet.encryptionPublicKey) {
        toast.error("Wallet missing encryption key", {
          description: "Please create a new wallet to use encrypted messaging",
        });
        setIsReregistering(false);
        return;
      }
      console.log("Registering wallet with encryption key:", wallet.encryptionPublicKey.slice(0, 32) + "...");
      await registerWalletOnNode({
        id: wallet.id,
        displayName: wallet.displayName,
        signingPublicKey: wallet.signingPublicKey,
        encryptionPublicKey: wallet.encryptionPublicKey,
      });
      toast.success("Wallet registered!", {
        description: "Your wallet is now visible to other users",
      });
      loadContacts();
    } catch (error) {
      console.error("Re-registration failed:", error);
      toast.error("Registration failed", {
        description: "Make sure the node is running",
      });
    } finally {
      setIsReregistering(false);
    }
  };

  const handleRegenerateKeys = async () => {
    if (!wallet || isRegeneratingKeys) return;
    setIsRegeneratingKeys(true);
    try {
      // Only regenerate encryption keys (ML-KEM-768) — signing keys = wallet identity
      const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
      const bytesToHex = (bytes: Uint8Array) =>
        Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

      const encKeypair = ml_kem768.keygen();

      const updated: UnifiedWallet = {
        ...wallet,
        // Signing keys stay the same — they ARE your wallet address
        encryptionPublicKey: bytesToHex(encKeypair.publicKey),
        encryptionPrivateKey: bytesToHex(encKeypair.secretKey),
      };

      saveUnifiedWallet(updated);
      setWallet(updated);

      // Re-register with new encryption public key
      await registerWalletOnNode({
        id: updated.id,
        displayName: updated.displayName,
        signingPublicKey: updated.signingPublicKey,
        encryptionPublicKey: updated.encryptionPublicKey,
      });

      toast.success("Encryption keys regenerated!", {
        description: "Fresh ML-KEM-768 keys registered. Your wallet address is unchanged.",
      });
      loadContacts();
    } catch (error) {
      console.error("Key regeneration failed:", error);
      toast.error("Key regeneration failed", {
        description: String(error),
      });
    } finally {
      setIsRegeneratingKeys(false);
    }
  };

  const handleNamePromptSave = async () => {
    if (!wallet || !promptName.trim()) return;
    const updated: UnifiedWallet = { ...wallet, displayName: promptName.trim() };
    saveUnifiedWallet(updated);
    setWallet(updated);
    setShowNamePrompt(false);
    setPromptName("");
    // Re-register with updated name
    try {
      await registerWalletOnNode({
        id: updated.id,
        displayName: updated.displayName,
        signingPublicKey: updated.signingPublicKey,
        encryptionPublicKey: updated.encryptionPublicKey,
      });
      toast.success(`Name set to "${updated.displayName}"`);
    } catch {
      toast.success(`Name saved locally as "${updated.displayName}"`);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        >
          <Lock className="w-8 h-8 text-primary" />
        </motion.div>
      </div>
    );
  }

  // Show wallet setup if no wallet
  if (!wallet) {
    if (isLocked) {
      const meta = getLockedWalletMetadata();
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-card border border-border rounded-xl p-6 space-y-4">
            <h2 className="text-lg font-semibold">Wallet Locked</h2>
            <p className="text-sm text-muted-foreground">
              {meta?.displayName ? `${meta.displayName} is locked.` : "Your wallet is locked."}
            </p>
            {meta?.signingPublicKey && (
              <p className="text-xs font-mono text-muted-foreground break-all">
                {meta.signingPublicKey}
              </p>
            )}
            <Input
              type="password"
              placeholder="Enter vault password"
              value={unlockPassword}
              onChange={(e) => setUnlockPassword(e.target.value)}
            />
            <Button className="w-full" onClick={handleUnlock} disabled={unlocking}>
              {unlocking ? "Unlocking..." : "Unlock Wallet"}
            </Button>
          </div>
        </div>
      );
    }
    return <WalletSetup onWalletCreated={handleWalletCreated} onWalletImported={handleWalletImport} />;
  }

  return (
    <div className="flex flex-col overflow-hidden h-[calc(100dvh-3.5rem)] md:h-dvh max-w-full">

      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      {/* Action Bar */}
      <div className="sticky top-0 z-40 flex items-center justify-between px-2 sm:px-4 py-2 bg-background/80 backdrop-blur-sm border-b border-border gap-1 overflow-x-hidden w-full min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Key className="w-4 h-4 text-primary flex-shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium text-foreground truncate">
              {wallet.displayName}
            </span>
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground font-mono hover:text-foreground transition-colors"
              onClick={() => {
                navigator.clipboard.writeText(wallet.signingPublicKey);
                toast.success("Address copied!");
              }}
              title="Click to copy full address"
            >
              <span className="truncate max-w-[120px] sm:max-w-[200px]">
                {walletRougeAddr || `${wallet.signingPublicKey.substring(0, 12)}...`}
              </span>
              <Copy className="w-3 h-3 flex-shrink-0" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSwapWidget(true)}
            title="Quick Swap"
          >
            <ArrowDownUp className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleReregister}
            disabled={isReregistering}
            title="Re-register wallet with network"
          >
            <RefreshCw className={`w-4 h-4 ${isReregistering ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRegenerateKeys}
            disabled={isRegeneratingKeys}
            title="Regenerate encryption keys (fixes key mismatch errors)"
          >
            <KeyRound className={`w-4 h-4 ${isRegeneratingKeys ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowWalletBackup(true)}
            title="Backup Wallet"
          >
            <Download className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              const settings = loadNotificationSettings();
              const toggled = !settings.enabled;
              saveNotificationSettings({ ...settings, enabled: toggled });
              setNotifEnabled(toggled);
              if (toggled) {
                requestNotificationPermission().then(granted => {
                  if (granted) toast.success("Notifications enabled");
                  else toast.info("Notifications enabled (desktop blocked by browser)");
                });
              } else {
                toast.info("Notifications muted");
              }
            }}
            title={notifEnabled ? "Mute notifications" : "Enable notifications"}
          >
            {notifEnabled ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4 text-muted-foreground" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowPrivacySettings(true)}
            title="Privacy Settings"
          >
            <Settings className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowContactPicker(true)}
            title="New Chat"
            className="sm:hidden"
          >
            <Plus className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowContactPicker(true)}
            className="hidden sm:flex"
          >
            <Plus className="w-4 h-4 mr-1" />
            New Chat
          </Button>
        </div>
      </div>

      {/* Main content */}
      <main className="relative z-10 flex-1 flex overflow-hidden w-full min-w-0">
        {/* Conversation list */}
        <div className={`w-full sm:w-80 border-r border-border ${selectedConversation ? 'hidden sm:block' : ''}`}>
          <ConversationList
            conversations={conversations}
            selectedId={selectedConversation?.id}
            currentWalletId={wallet.id}
            currentWalletKeys={[wallet.signingPublicKey, wallet.encryptionPublicKey]}
            currentWalletName={wallet.displayName}
            onSelect={setSelectedConversation}
            onDelete={(id) => {
              setConversations(prev => prev.filter(c => c.id !== id));
              if (selectedConversation?.id === id) {
                setSelectedConversation(null);
              }
            }}
          />
        </div>

        {/* Chat view */}
        <div className={`flex-1 overflow-hidden min-w-0 ${!selectedConversation ? 'hidden sm:flex' : 'flex'}`}>
          {selectedConversation && messengerWallet ? (
            <ChatView
              conversation={selectedConversation}
              wallet={messengerWallet}
              onBack={() => setSelectedConversation(null)}
              onBlocked={() => {
                setSelectedConversation(null);
                loadConversations();
                loadContacts();
              }}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Shield className="w-16 h-16 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium">Select a conversation</p>
                <p className="text-sm">Or start a new chat with quantum-safe encryption</p>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Contact picker modal */}
      <AnimatePresence>
        {showContactPicker && messengerWallet && (
          <ContactPicker
            contacts={contacts}
            wallet={messengerWallet}
            onClose={() => setShowContactPicker(false)}
            onConversationCreated={handleConversationCreated}
          />
        )}
      </AnimatePresence>

      {/* Privacy settings modal */}
      <AnimatePresence>
        {showPrivacySettings && (
          <PrivacySettings
            onClose={() => setShowPrivacySettings(false)}
            onProfileUpdated={() => {
              // Refresh wallet state
              const updated = loadUnifiedWallet();
              if (updated) {
                setWallet(updated);
              }
            }}
          />
        )}
      </AnimatePresence>

      {/* Wallet backup modal */}
      <AnimatePresence>
        {showWalletBackup && (
          <WalletBackup
            wallet={wallet}
            onClose={() => setShowWalletBackup(false)}
            onImport={handleWalletImport}
            onLocked={() => {
              setWallet(null);
              setIsLocked(true);
            }}
            vaultSettings={vaultSettings}
            onUpdateVaultSettings={handleVaultSettings}
          />
        )}
      </AnimatePresence>

      {/* Swap widget modal */}
      <AnimatePresence>
        {showSwapWidget && wallet?.signingPrivateKey && (
          <SwapWidget
            walletPublicKey={wallet.signingPublicKey}
            walletPrivateKey={wallet.signingPrivateKey}
            onClose={() => setShowSwapWidget(false)}
          />
        )}
      </AnimatePresence>

      {/* Display name prompt dialog */}
      <AnimatePresence>
        {showNamePrompt && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => setShowNamePrompt(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-card border border-border rounded-xl p-6 w-full max-w-sm space-y-4 shadow-xl"
            >
              <div className="flex flex-col items-center gap-2">
                <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center">
                  <UserCircle className="w-6 h-6 text-primary" />
                </div>
                <h3 className="text-lg font-semibold">Set Your Display Name</h3>
                <p className="text-sm text-muted-foreground text-center">
                  Choose a name so other users can recognize you in conversations.
                </p>
              </div>
              <Input
                value={promptName}
                onChange={(e) => setPromptName(e.target.value)}
                placeholder="Enter your name..."
                className="h-12"
                onKeyDown={(e) => e.key === "Enter" && handleNamePromptSave()}
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setShowNamePrompt(false)}
                >
                  Later
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleNamePromptSave}
                  disabled={!promptName.trim()}
                >
                  Save Name
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Messenger;
