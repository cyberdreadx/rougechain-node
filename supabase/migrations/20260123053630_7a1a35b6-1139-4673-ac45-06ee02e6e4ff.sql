-- PQC Messenger Schema

-- Wallets table (anonymous, stored locally but public keys synced)
CREATE TABLE public.wallets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  display_name TEXT NOT NULL,
  signing_public_key TEXT NOT NULL, -- ML-DSA-65 public key
  encryption_public_key TEXT NOT NULL, -- ML-KEM-768 public key
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;

-- Anyone can read wallets (to look up public keys)
CREATE POLICY "Anyone can read wallets"
  ON public.wallets FOR SELECT
  USING (true);

-- Anyone can create wallets (anonymous)
CREATE POLICY "Anyone can create wallets"
  ON public.wallets FOR INSERT
  WITH CHECK (true);

-- Conversations (1:1 or group)
CREATE TABLE public.conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT, -- NULL for 1:1, set for groups
  is_group BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES public.wallets(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

-- Anyone can read/create conversations (anonymous app)
CREATE POLICY "Anyone can read conversations"
  ON public.conversations FOR SELECT
  USING (true);

CREATE POLICY "Anyone can create conversations"
  ON public.conversations FOR INSERT
  WITH CHECK (true);

-- Conversation participants
CREATE TABLE public.conversation_participants (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
  encrypted_group_key TEXT, -- For groups: group key encrypted with this participant's ML-KEM pubkey
  joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, wallet_id)
);

-- Enable RLS
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read participants"
  ON public.conversation_participants FOR SELECT
  USING (true);

CREATE POLICY "Anyone can add participants"
  ON public.conversation_participants FOR INSERT
  WITH CHECK (true);

-- Encrypted messages
CREATE TABLE public.encrypted_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_wallet_id UUID NOT NULL REFERENCES public.wallets(id),
  
  -- For 1:1: encrypted with recipient's pubkey
  -- For group: encrypted with group key
  encrypted_content TEXT NOT NULL,
  
  -- ML-DSA-65 signature of the plaintext
  signature TEXT NOT NULL,
  
  -- Encryption metadata
  encryption_type TEXT NOT NULL DEFAULT 'ML-KEM-768', -- or 'group-key'
  
  -- Self-destruct settings
  self_destruct BOOLEAN NOT NULL DEFAULT false,
  destruct_after_seconds INTEGER, -- TTL after reading
  read_at TIMESTAMP WITH TIME ZONE, -- When first read by recipient
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.encrypted_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read messages"
  ON public.encrypted_messages FOR SELECT
  USING (true);

CREATE POLICY "Anyone can send messages"
  ON public.encrypted_messages FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update messages"
  ON public.encrypted_messages FOR UPDATE
  USING (true);

CREATE POLICY "Anyone can delete messages"
  ON public.encrypted_messages FOR DELETE
  USING (true);

-- Index for efficient message queries
CREATE INDEX idx_messages_conversation ON public.encrypted_messages(conversation_id, created_at DESC);
CREATE INDEX idx_participants_wallet ON public.conversation_participants(wallet_id);

-- Enable realtime for messages
ALTER PUBLICATION supabase_realtime ADD TABLE public.encrypted_messages;