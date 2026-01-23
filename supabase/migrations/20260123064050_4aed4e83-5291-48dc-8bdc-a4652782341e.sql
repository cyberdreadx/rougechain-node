-- Validator tiers enum
CREATE TYPE public.validator_tier AS ENUM ('standard', 'operator', 'genesis');

-- Validator status enum  
CREATE TYPE public.validator_status AS ENUM ('pending', 'active', 'jailed', 'unbonding', 'inactive');

-- Validators table - stores registered validators
CREATE TABLE public.validators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL,
  tier validator_tier NOT NULL DEFAULT 'standard',
  status validator_status NOT NULL DEFAULT 'pending',
  staked_amount BIGINT NOT NULL DEFAULT 0,
  signing_public_key TEXT NOT NULL,
  commission_rate DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  blocks_proposed INTEGER NOT NULL DEFAULT 0,
  blocks_validated INTEGER NOT NULL DEFAULT 0,
  uptime_percentage DECIMAL(5,2) NOT NULL DEFAULT 100.00,
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unbonding_at TIMESTAMPTZ,
  slashed_amount BIGINT NOT NULL DEFAULT 0,
  quantum_entropy_contributions INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT min_stake_check CHECK (staked_amount >= 0),
  CONSTRAINT commission_check CHECK (commission_rate >= 0 AND commission_rate <= 100)
);

-- Staking history for tracking deposits/withdrawals
CREATE TABLE public.staking_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  validator_id UUID NOT NULL REFERENCES public.validators(id) ON DELETE CASCADE,
  action TEXT NOT NULL, -- 'stake', 'unstake', 'slash', 'reward'
  amount BIGINT NOT NULL,
  block_index INTEGER,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Block validations - records which validators signed each block
CREATE TABLE public.block_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  block_hash TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  validator_id UUID NOT NULL REFERENCES public.validators(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_proposer BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(block_hash, validator_id)
);

-- Quantum entropy pool - for VRF-style random selection
CREATE TABLE public.quantum_entropy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  validator_id UUID NOT NULL REFERENCES public.validators(id) ON DELETE CASCADE,
  entropy_value TEXT NOT NULL, -- quantum random bytes
  block_index INTEGER NOT NULL,
  used_for_selection BOOLEAN NOT NULL DEFAULT false,
  contributed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Validator rewards tracking
CREATE TABLE public.validator_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  validator_id UUID NOT NULL REFERENCES public.validators(id) ON DELETE CASCADE,
  block_index INTEGER NOT NULL,
  reward_amount BIGINT NOT NULL,
  fee_share BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Slashing events
CREATE TABLE public.slashing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  validator_id UUID NOT NULL REFERENCES public.validators(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, -- 'double_sign', 'downtime', 'invalid_block'
  amount_slashed BIGINT NOT NULL,
  evidence TEXT,
  block_index INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.validators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staking_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.block_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quantum_entropy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.validator_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slashing_events ENABLE ROW LEVEL SECURITY;

-- Validators: anyone can view, but we'll handle writes via edge function
CREATE POLICY "Anyone can view validators" ON public.validators FOR SELECT USING (true);
CREATE POLICY "Edge function manages validators" ON public.validators FOR ALL USING (true);

-- Staking history: public read
CREATE POLICY "Anyone can view staking history" ON public.staking_history FOR SELECT USING (true);
CREATE POLICY "Edge function manages staking" ON public.staking_history FOR ALL USING (true);

-- Block validations: public read
CREATE POLICY "Anyone can view block validations" ON public.block_validations FOR SELECT USING (true);
CREATE POLICY "Edge function manages validations" ON public.block_validations FOR ALL USING (true);

-- Quantum entropy: public read
CREATE POLICY "Anyone can view entropy" ON public.quantum_entropy FOR SELECT USING (true);
CREATE POLICY "Edge function manages entropy" ON public.quantum_entropy FOR ALL USING (true);

-- Validator rewards: public read
CREATE POLICY "Anyone can view rewards" ON public.validator_rewards FOR SELECT USING (true);
CREATE POLICY "Edge function manages rewards" ON public.validator_rewards FOR ALL USING (true);

-- Slashing events: public read
CREATE POLICY "Anyone can view slashing" ON public.slashing_events FOR SELECT USING (true);
CREATE POLICY "Edge function manages slashing" ON public.slashing_events FOR ALL USING (true);

-- Add indexes for performance
CREATE INDEX idx_validators_status ON public.validators(status);
CREATE INDEX idx_validators_tier ON public.validators(tier);
CREATE INDEX idx_validators_staked ON public.validators(staked_amount DESC);
CREATE INDEX idx_block_validations_block ON public.block_validations(block_index);
CREATE INDEX idx_staking_history_validator ON public.staking_history(validator_id);
CREATE INDEX idx_quantum_entropy_block ON public.quantum_entropy(block_index);
CREATE INDEX idx_validator_rewards_validator ON public.validator_rewards(validator_id);

-- Enable realtime for validators table
ALTER PUBLICATION supabase_realtime ADD TABLE public.validators;