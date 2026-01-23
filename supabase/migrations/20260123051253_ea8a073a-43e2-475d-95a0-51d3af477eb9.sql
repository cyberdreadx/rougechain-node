-- Create blockchain tables for PQC chain persistence

-- Store keypairs (public key only stored, private key handled client-side)
CREATE TABLE public.pqc_keypairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'ML-DSA-65',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Store blockchain blocks
CREATE TABLE public.pqc_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  block_index INTEGER NOT NULL,
  timestamp BIGINT NOT NULL,
  data TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  signature TEXT NOT NULL,
  signer_public_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(block_index),
  UNIQUE(hash)
);

-- Enable RLS
ALTER TABLE public.pqc_keypairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pqc_blocks ENABLE ROW LEVEL SECURITY;

-- Public read access for the blockchain (it's a public chain)
CREATE POLICY "Anyone can read keypairs"
  ON public.pqc_keypairs FOR SELECT
  USING (true);

CREATE POLICY "Anyone can read blocks"
  ON public.pqc_blocks FOR SELECT
  USING (true);

-- Anyone can add to the chain (public blockchain)
CREATE POLICY "Anyone can create keypairs"
  ON public.pqc_keypairs FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can create blocks"
  ON public.pqc_blocks FOR INSERT
  WITH CHECK (true);

-- Create index for efficient block ordering
CREATE INDEX idx_pqc_blocks_index ON public.pqc_blocks(block_index);

-- Enable realtime for blocks
ALTER PUBLICATION supabase_realtime ADD TABLE public.pqc_blocks;