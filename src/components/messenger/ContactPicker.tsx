import { useState } from "react";
import { motion } from "framer-motion";
import { X, User, MessageSquare, Loader2, Bot, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Wallet, WalletWithPrivateKeys, Conversation } from "@/lib/pqc-messenger";
import { createConversation, getOrCreateDemoBot } from "@/lib/pqc-messenger";

interface ContactPickerProps {
  contacts: Wallet[];
  wallet: WalletWithPrivateKeys;
  onClose: () => void;
  onConversationCreated: (conversation: Conversation) => void;
}

const ContactPicker = ({ contacts, wallet, onClose, onConversationCreated }: ContactPickerProps) => {
  const [isCreating, setIsCreating] = useState<string | null>(null);
  const [isCreatingBot, setIsCreatingBot] = useState(false);

  const handleSelectContact = async (contact: Wallet) => {
    setIsCreating(contact.id);
    try {
      const conversation = await createConversation(wallet.id, contact.id);
      // Add participant info
      conversation.participants = [
        {
          id: wallet.id,
          displayName: wallet.displayName,
          signingPublicKey: wallet.signingPublicKey,
          encryptionPublicKey: wallet.encryptionPublicKey,
        },
        contact,
      ];
      onConversationCreated(conversation);
    } catch (error) {
      console.error("Failed to create conversation:", error);
    } finally {
      setIsCreating(null);
    }
  };

  const handleStartDemoMode = async () => {
    setIsCreatingBot(true);
    try {
      // Get or create the demo bot
      const botWallet = await getOrCreateDemoBot();
      
      // Create conversation with the bot
      const conversation = await createConversation(wallet.id, botWallet.id);
      conversation.participants = [
        {
          id: wallet.id,
          displayName: wallet.displayName,
          signingPublicKey: wallet.signingPublicKey,
          encryptionPublicKey: wallet.encryptionPublicKey,
        },
        {
          id: botWallet.id,
          displayName: botWallet.displayName,
          signingPublicKey: botWallet.signingPublicKey,
          encryptionPublicKey: botWallet.encryptionPublicKey,
        },
      ];
      onConversationCreated(conversation);
    } catch (error) {
      console.error("Failed to create demo mode:", error);
    } finally {
      setIsCreatingBot(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-card rounded-xl border border-border shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold">Start New Chat</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Demo Mode Button */}
        <div className="p-4 border-b border-border">
          <button
            onClick={handleStartDemoMode}
            disabled={isCreatingBot || isCreating !== null}
            className="w-full p-4 rounded-xl bg-gradient-to-r from-primary/20 to-accent/20 border border-primary/30 hover:border-primary/50 transition-all flex items-center gap-4 disabled:opacity-50"
          >
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              {isCreatingBot ? (
                <Loader2 className="w-6 h-6 text-primary-foreground animate-spin" />
              ) : (
                <Bot className="w-6 h-6 text-primary-foreground" />
              )}
            </div>
            <div className="flex-1 text-left">
              <div className="flex items-center gap-2">
                <p className="font-semibold text-foreground">🤖 Quantum Bot</p>
                <span className="px-2 py-0.5 text-xs rounded-full bg-primary/20 text-primary flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  Demo
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Test encryption with an auto-responding bot
              </p>
            </div>
          </button>
        </div>

        {/* Contact list */}
        <div className="max-h-64 overflow-y-auto">
          {contacts.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">
              <User className="w-10 h-10 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No other users yet</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {contacts.map((contact) => (
                <button
                  key={contact.id}
                  onClick={() => handleSelectContact(contact)}
                  disabled={isCreating !== null || isCreatingBot}
                  className="w-full p-4 flex items-center gap-3 hover:bg-muted/50 transition-colors disabled:opacity-50"
                >
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                    <User className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-medium text-foreground">{contact.displayName}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {contact.encryptionPublicKey.slice(0, 16)}...
                    </p>
                  </div>
                  {isCreating === contact.id ? (
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  ) : (
                    <MessageSquare className="w-5 h-5 text-muted-foreground" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};

export default ContactPicker;
