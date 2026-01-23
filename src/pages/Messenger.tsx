import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Shield, Plus, Lock, Key, Settings, Download } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import WalletSetup from "@/components/messenger/WalletSetup";
import ConversationList from "@/components/messenger/ConversationList";
import ChatView from "@/components/messenger/ChatView";
import ContactPicker from "@/components/messenger/ContactPicker";
import PrivacySettings from "@/components/messenger/PrivacySettings";
import WalletBackup from "@/components/wallet/WalletBackup";
import type { Conversation, Wallet, WalletWithPrivateKeys } from "@/lib/pqc-messenger";
import { getConversations, getWallets, saveWalletLocally } from "@/lib/pqc-messenger";
import { 
  UnifiedWallet, 
  loadUnifiedWallet, 
  saveUnifiedWallet, 
  toMessengerWallet, 
  fromMessengerWallet 
} from "@/lib/unified-wallet";
import xrgeLogo from "@/assets/xrge-logo.webp";

const Messenger = () => {
  const [wallet, setWallet] = useState<UnifiedWallet | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [contacts, setContacts] = useState<Wallet[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [showPrivacySettings, setShowPrivacySettings] = useState(false);
  const [showWalletBackup, setShowWalletBackup] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Load wallet from localStorage on mount
  useEffect(() => {
    const savedWallet = loadUnifiedWallet();
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
    return <WalletSetup onWalletCreated={handleWalletCreated} />;
  }

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="sticky top-0 z-50 flex items-center justify-between px-4 py-4 border-b border-border bg-card/50 backdrop-blur-xl"
      >
        <div className="flex items-center gap-3">
          <Link to="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <img src={xrgeLogo} alt="XRGE" className="w-8 h-8 rounded-full" />
            <div>
              <h1 className="text-lg font-bold text-foreground">Rouge Messenger</h1>
              <p className="text-xs text-muted-foreground">End-to-end quantum-safe</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
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
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary border border-border">
            <Key className="w-4 h-4 text-primary" />
            <span className="text-xs text-muted-foreground truncate max-w-[100px]">
              {wallet.displayName}
            </span>
          </div>
        </div>
      </motion.header>

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
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default Messenger;
