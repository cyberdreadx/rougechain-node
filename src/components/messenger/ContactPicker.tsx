import { useState } from "react";
import { motion } from "framer-motion";
import { X, User, MessageSquare, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Wallet, WalletWithPrivateKeys, Conversation } from "@/lib/pqc-messenger";
import { createConversation } from "@/lib/pqc-messenger";

interface ContactPickerProps {
  contacts: Wallet[];
  wallet: WalletWithPrivateKeys;
  onClose: () => void;
  onConversationCreated: (conversation: Conversation) => void;
}

const ContactPicker = ({ contacts, wallet, onClose, onConversationCreated }: ContactPickerProps) => {
  const [isCreating, setIsCreating] = useState<string | null>(null);

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

        {/* Contact list */}
        <div className="max-h-96 overflow-y-auto">
          {contacts.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <User className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No other users yet</p>
              <p className="text-sm mt-1">Share your app to invite others</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {contacts.map((contact) => (
                <button
                  key={contact.id}
                  onClick={() => handleSelectContact(contact)}
                  disabled={isCreating !== null}
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
