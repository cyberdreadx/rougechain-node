import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, Plus, Lock, Key, Settings, Download, RefreshCw, ArrowDownUp } from "lucide-react";
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
import { getConversations, getWallets, saveWalletLocally, registerWalletOnNode } from "@/lib/pqc-messenger";
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
  const [isLocked, setIsLocked] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [vaultSettings, setVaultSettings] = useState<VaultSettings>(() => getVaultSettings());

  // Load wallet from localStorage on mount
  useEffect(() => {
    const locked = isWalletLocked();
    setIsLocked(locked);
    const savedWallet = locked ? null : loadUnifiedWallet();
    if (savedWallet) {
      setWallet(savedWallet);
    }
    setIsLoading(false);
  }, []);

  // Load conversations when wallet is available
  useEffect(() => {
    if (wallet) {
      loadConversations();
      loadContacts();
    }
  }, [wallet]);

  useEffect(() => {
    setVaultSettings(getVaultSettings());
  }, []);

  const loadConversations = async () => {
    if (!wallet) return;
    try {
      const convs = await getConversations(wallet.id);
      setConversations(convs);
    } catch (error) {
      console.error("Failed to load conversations:", error);
    }
  };

  const loadContacts = async () => {
    try {
      const wallets = await getWallets();
      // Filter out our own wallet
      setContacts(wallets.filter(w => w.id !== wallet?.id));
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
      const unlocked = await unlockUnifiedWallet(unlockPassword.trim());
      setWallet(unlocked);
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
      // Refresh contacts after re-registration
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
    return <WalletSetup onWalletCreated={handleWalletCreated} />;
  }

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      {/* Action Bar */}
      <div className="sticky top-[60px] z-40 flex items-center justify-between px-4 py-2 bg-background/80 backdrop-blur-sm border-b border-border">
        <div className="flex items-center gap-2">
          <Key className="w-4 h-4 text-primary" />
          <span className="text-sm text-muted-foreground truncate max-w-[150px]">
            {wallet.displayName}
          </span>
        </div>
        <div className="flex items-center gap-2">
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
            onClick={() => setShowWalletBackup(true)}
            title="Backup Wallet"
          >
            <Download className="w-4 h-4" />
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
            size="sm"
            onClick={() => setShowContactPicker(true)}
          >
            <Plus className="w-4 h-4 mr-1" />
            New Chat
          </Button>
        </div>
      </div>

      {/* Main content */}
      <main className="relative z-10 h-[calc(100vh-73px)] flex">
        {/* Conversation list */}
        <div className={`w-full sm:w-80 border-r border-border ${selectedConversation ? 'hidden sm:block' : ''}`}>
          <ConversationList
            conversations={conversations}
            selectedId={selectedConversation?.id}
            currentWalletId={wallet.id}
            onSelect={setSelectedConversation}
          />
        </div>

        {/* Chat view */}
        <div className={`flex-1 ${!selectedConversation ? 'hidden sm:flex' : 'flex'}`}>
          {selectedConversation && messengerWallet ? (
            <ChatView
              conversation={selectedConversation}
              wallet={messengerWallet}
              onBack={() => setSelectedConversation(null)}
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
          <PrivacySettings onClose={() => setShowPrivacySettings(false)} />
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
    </div>
  );
};

export default Messenger;
