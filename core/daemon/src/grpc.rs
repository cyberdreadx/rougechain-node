use std::sync::Arc;

use tonic::{Request, Response, Status};

use crate::node::L1Node;

pub mod proto {
    tonic::include_proto!("quantumvault");
}

pub const FILE_DESCRIPTOR_SET: &[u8] = tonic::include_file_descriptor_set!("quantum_vault_descriptor");

use proto::chain_service_server::{ChainService, ChainServiceServer};
use proto::messenger_service_server::{MessengerService, MessengerServiceServer};
use proto::validator_service_server::{ValidatorService, ValidatorServiceServer};
use proto::wallet_service_server::{WalletService, WalletServiceServer};

use proto::*;

#[derive(Clone)]
pub struct GrpcNode {
    node: Arc<L1Node>,
}

impl GrpcNode {
    pub fn new(node: Arc<L1Node>) -> Self {
        Self { node }
    }

    pub fn chain_service(self) -> ChainServiceServer<Self> {
        ChainServiceServer::new(self)
    }

    pub fn wallet_service(self) -> WalletServiceServer<Self> {
        WalletServiceServer::new(self)
    }

    pub fn validator_service(self) -> ValidatorServiceServer<Self> {
        ValidatorServiceServer::new(self)
    }

    pub fn messenger_service(self) -> MessengerServiceServer<Self> {
        MessengerServiceServer::new(self)
    }
}

#[tonic::async_trait]
impl ChainService for GrpcNode {
    async fn get_stats(&self, _request: Request<Empty>) -> Result<Response<NodeStats>, Status> {
        let height = self.node.get_tip_height().map_err(|e| Status::internal(e))?;
        let (total_fees, last_fees) = self.node.get_fee_stats().map_err(|e| Status::internal(e))?;
        let (finalized, _, _, _) = self.node.get_finality_status().map_err(|e| Status::internal(e))?;
        Ok(Response::new(NodeStats {
            node_id: self.node.node_id(),
            network_height: height,
            connected_peers: 0,
            is_mining: self.node.is_mining(),
            chain_id: self.node.chain_id(),
            finalized_height: finalized,
            total_fees_collected: total_fees,
            fees_in_last_block: last_fees,
        }))
    }

    async fn get_blocks(&self, request: Request<BlocksRequest>) -> Result<Response<BlocksResponse>, Status> {
        let limit = request.into_inner().limit as usize;
        let blocks = if limit > 0 {
            self.node.get_recent_blocks(limit).map_err(|e| Status::internal(e))?
        } else {
            self.node.get_all_blocks().map_err(|e| Status::internal(e))?
        };
        Ok(Response::new(BlocksResponse {
            blocks: blocks.into_iter().map(map_block).collect(),
        }))
    }

    async fn get_balance(&self, request: Request<BalanceRequest>) -> Result<Response<BalanceResponse>, Status> {
        let public_key = request.into_inner().public_key;
        let balance = self.node.get_balance(&public_key).map_err(|e| Status::internal(e))?;
        Ok(Response::new(BalanceResponse { balance }))
    }

    async fn submit_tx(&self, request: Request<SubmitTxRequest>) -> Result<Response<SubmitTxResponse>, Status> {
        let req = request.into_inner();
        let tx = self.node.submit_user_tx(
            &req.from_private_key,
            &req.from_public_key,
            &req.to_public_key,
            req.amount as f64,
            Some(req.fee),
        ).map_err(|e| Status::invalid_argument(e))?;
        let tx_id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
        Ok(Response::new(SubmitTxResponse {
            tx_id,
            tx: Some(map_tx(&tx)),
        }))
    }

    async fn faucet(&self, request: Request<FaucetRequest>) -> Result<Response<SubmitTxResponse>, Status> {
        let req = request.into_inner();
        let tx = self.node.submit_faucet_tx(&req.recipient_public_key, req.amount)
            .map_err(|e| Status::invalid_argument(e))?;
        let tx_id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
        Ok(Response::new(SubmitTxResponse {
            tx_id,
            tx: Some(map_tx(&tx)),
        }))
    }
}

#[tonic::async_trait]
impl WalletService for GrpcNode {
    async fn create_wallet(&self, _request: Request<Empty>) -> Result<Response<KeyPair>, Status> {
        let wallet = self.node.create_wallet();
        Ok(Response::new(KeyPair {
            algorithm: wallet.algorithm,
            public_key_hex: wallet.public_key_hex,
            secret_key_hex: wallet.secret_key_hex,
        }))
    }
}

#[tonic::async_trait]
impl ValidatorService for GrpcNode {
    async fn get_validator_set(&self, _request: Request<Empty>) -> Result<Response<ValidatorSet>, Status> {
        let (validators, total) = self.node.get_validator_set().map_err(|e| Status::internal(e))?;
        let tip = self.node.get_tip_height().unwrap_or(0);
        let validators = validators.into_iter().map(|(public_key, state)| {
            let status = if state.jailed_until > tip {
                "jailed"
            } else if state.stake > 0 {
                "active"
            } else {
                "inactive"
            };
            ValidatorInfo {
                public_key,
                stake: state.stake.to_string(),
                status: status.to_string(),
                slash_count: state.slash_count,
                jailed_until: state.jailed_until,
                entropy_contributions: state.entropy_contributions,
            }
        }).collect();
        Ok(Response::new(ValidatorSet {
            validators,
            total_stake: total.to_string(),
        }))
    }

    async fn get_selection_info(&self, _request: Request<Empty>) -> Result<Response<SelectionInfo>, Status> {
        let height = self.node.get_tip_height().map_err(|e| Status::internal(e))? + 1;
        let selection = self.node.get_selection_info().map_err(|e| Status::internal(e))?;
        if let Some(result) = selection {
            Ok(Response::new(SelectionInfo {
                height,
                proposer: result.proposer_pub_key,
                total_stake: result.total_stake.to_string(),
                selection_weight: result.selection_weight.to_string(),
                entropy_source: result.entropy_source,
                entropy_hex: result.entropy_hex,
            }))
        } else {
            Ok(Response::new(SelectionInfo {
                height,
                proposer: "".to_string(),
                total_stake: "0".to_string(),
                selection_weight: "0".to_string(),
                entropy_source: "none".to_string(),
                entropy_hex: "".to_string(),
            }))
        }
    }

    async fn get_finality(&self, _request: Request<Empty>) -> Result<Response<FinalityStatus>, Status> {
        let (finalized, tip, total, quorum) = self.node.get_finality_status().map_err(|e| Status::internal(e))?;
        Ok(Response::new(FinalityStatus {
            finalized_height: finalized,
            tip_height: tip,
            total_stake: total.to_string(),
            quorum_stake: quorum.to_string(),
        }))
    }

    async fn get_vote_summary(&self, request: Request<BalanceRequest>) -> Result<Response<VoteSummary>, Status> {
        let height = request.into_inner().public_key.parse::<u64>().unwrap_or(0);
        let (total, quorum, votes) = self.node.get_vote_summary(height).map_err(|e| Status::internal(e))?;
        let mut buckets: std::collections::HashMap<String, (u32, u128)> = std::collections::HashMap::new();
        for vote in votes {
            let entry = buckets.entry(vote.block_hash.clone()).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += 1;
        }
        let to_bucket = |(hash, (voters, stake)): (String, (u32, u128))| VoteBucket {
            block_hash: hash,
            voters,
            stake: stake.to_string(),
        };
        Ok(Response::new(VoteSummary {
            height,
            total_stake: total.to_string(),
            quorum_stake: quorum.to_string(),
            prevote: buckets.clone().into_iter().map(to_bucket).collect(),
            precommit: buckets.into_iter().map(to_bucket).collect(),
        }))
    }

    async fn get_vote_stats(&self, _request: Request<Empty>) -> Result<Response<VoteStats>, Status> {
        let stats = self.node.get_vote_stats().map_err(|e| Status::internal(e))?;
        let validators: Vec<ValidatorVoteStats> = stats.into_iter().map(|(public_key, prevote, precommit, last)| {
            ValidatorVoteStats {
                public_key,
                prevote_participation: prevote,
                precommit_participation: precommit,
                last_seen_height: last,
            }
        }).collect();
        Ok(Response::new(VoteStats {
            total_heights: validators.len() as u32,
            validators,
        }))
    }

    async fn submit_vote(&self, request: Request<VoteRequest>) -> Result<Response<Empty>, Status> {
        let vote = request.into_inner();
        self.node.submit_vote(quantum_vault_types::VoteMessage {
            vote_type: vote.vote_type,
            height: vote.height,
            round: vote.round,
            block_hash: vote.block_hash,
            voter_pub_key: vote.voter_pub_key,
            signature: vote.signature,
        }).map_err(|e| Status::internal(e))?;
        Ok(Response::new(Empty {}))
    }

    async fn submit_entropy(&self, request: Request<EntropyRequest>) -> Result<Response<Empty>, Status> {
        let public_key = request.into_inner().public_key;
        self.node.submit_entropy(&public_key).map_err(|e| Status::internal(e))?;
        Ok(Response::new(Empty {}))
    }

    async fn submit_stake(&self, request: Request<StakeRequest>) -> Result<Response<SubmitTxResponse>, Status> {
        let req = request.into_inner();
        let tx = self.node.submit_stake_tx(
            &req.from_private_key,
            &req.from_public_key,
            req.amount as f64,
            Some(req.fee),
        ).map_err(|e| Status::invalid_argument(e))?;
        let tx_id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
        Ok(Response::new(SubmitTxResponse { tx_id, tx: Some(map_tx(&tx)) }))
    }

    async fn submit_unstake(&self, request: Request<StakeRequest>) -> Result<Response<SubmitTxResponse>, Status> {
        let req = request.into_inner();
        let tx = self.node.submit_unstake_tx(
            &req.from_private_key,
            &req.from_public_key,
            req.amount as f64,
            Some(req.fee),
        ).map_err(|e| Status::invalid_argument(e))?;
        let tx_id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
        Ok(Response::new(SubmitTxResponse { tx_id, tx: Some(map_tx(&tx)) }))
    }
}

#[tonic::async_trait]
impl MessengerService for GrpcNode {
    async fn list_wallets(&self, _request: Request<Empty>) -> Result<Response<MessengerWallets>, Status> {
        let wallets = self.node.list_wallets().map_err(|e| Status::internal(e))?;
        Ok(Response::new(MessengerWallets {
            wallets: wallets.into_iter().map(map_wallet).collect(),
        }))
    }

    async fn register_wallet(&self, request: Request<RegisterWalletRequest>) -> Result<Response<Wallet>, Status> {
        let req = request.into_inner();
        let wallet = req.wallet.ok_or_else(|| Status::invalid_argument("wallet required"))?;
        let created = self.node.register_wallet(unmap_wallet(&wallet)).map_err(|e| Status::internal(e))?;
        Ok(Response::new(map_wallet(created)))
    }

    async fn list_conversations(&self, request: Request<BalanceRequest>) -> Result<Response<ConversationList>, Status> {
        let wallet_id = request.into_inner().public_key;
        let conversations = self.node.list_conversations(&wallet_id).map_err(|e| Status::internal(e))?;
        Ok(Response::new(ConversationList {
            conversations: conversations.into_iter().map(map_conversation).collect(),
        }))
    }

    async fn create_conversation(&self, request: Request<CreateConversationRequest>) -> Result<Response<Conversation>, Status> {
        let req = request.into_inner();
        let conversation = self.node.create_conversation(
            &req.created_by,
            req.participant_ids,
            if req.name.is_empty() { None } else { Some(req.name) },
            req.is_group,
        ).map_err(|e| Status::internal(e))?;
        Ok(Response::new(map_conversation(conversation)))
    }

    async fn list_messages(&self, request: Request<BalanceRequest>) -> Result<Response<MessageList>, Status> {
        let conversation_id = request.into_inner().public_key;
        let messages = self.node.list_messages(&conversation_id).map_err(|e| Status::internal(e))?;
        Ok(Response::new(MessageList {
            messages: messages.into_iter().map(map_message).collect(),
        }))
    }

    async fn send_message(&self, request: Request<SendMessageRequest>) -> Result<Response<MessengerMessage>, Status> {
        let req = request.into_inner();
        let message = quantum_vault_storage::messenger_store::MessengerMessage {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: req.conversation_id,
            sender_wallet_id: req.sender_wallet_id,
            encrypted_content: req.encrypted_content,
            signature: req.signature,
            self_destruct: req.self_destruct,
            destruct_after_seconds: if req.destruct_after_seconds == 0 { None } else { Some(req.destruct_after_seconds) },
            created_at: chrono::Utc::now().to_rfc3339(),
            is_read: false,
        };
        let stored = self.node.send_message(message).map_err(|e| Status::internal(e))?;
        Ok(Response::new(map_message(stored)))
    }

    async fn mark_read(&self, request: Request<ReadMessageRequest>) -> Result<Response<ReadMessageResponse>, Status> {
        let message_id = request.into_inner().message_id;
        let message = self.node.mark_message_read(&message_id).map_err(|e| Status::internal(e))?;
        Ok(Response::new(ReadMessageResponse { message: Some(map_message(message)) }))
    }
}

fn map_tx(tx: &quantum_vault_types::TxV1) -> Tx {
    Tx {
        version: tx.version,
        tx_type: tx.tx_type.clone(),
        from_pub_key: tx.from_pub_key.clone(),
        nonce: tx.nonce,
        payload: Some(TxPayload {
            to_pub_key_hex: tx.payload.to_pub_key_hex.clone().unwrap_or_default(),
            amount: tx.payload.amount.unwrap_or_default(),
            faucet: tx.payload.faucet.unwrap_or(false),
            target_pub_key: tx.payload.target_pub_key.clone().unwrap_or_default(),
            reason: tx.payload.reason.clone().unwrap_or_default(),
        }),
        fee: tx.fee,
        sig: tx.sig.clone(),
    }
}

fn map_block(block: quantum_vault_types::BlockV1) -> Block {
    let quantum_vault_types::BlockV1 {
        version,
        header,
        txs,
        proposer_sig,
        hash,
    } = block;
    Block {
        version,
        header: Some(BlockHeader {
            version: header.version,
            chain_id: header.chain_id,
            height: header.height,
            time: header.time,
            prev_hash: header.prev_hash,
            tx_hash: header.tx_hash,
            proposer_pub_key: header.proposer_pub_key,
        }),
        txs: txs.iter().map(|tx| map_tx(tx)).collect(),
        proposer_sig,
        hash,
    }
}

fn map_wallet(wallet: quantum_vault_storage::messenger_store::MessengerWallet) -> Wallet {
    Wallet {
        id: wallet.id,
        display_name: wallet.display_name,
        signing_public_key: wallet.signing_public_key,
        encryption_public_key: wallet.encryption_public_key,
        created_at: wallet.created_at,
    }
}

fn unmap_wallet(wallet: &Wallet) -> quantum_vault_storage::messenger_store::MessengerWallet {
    quantum_vault_storage::messenger_store::MessengerWallet {
        id: wallet.id.clone(),
        display_name: wallet.display_name.clone(),
        signing_public_key: wallet.signing_public_key.clone(),
        encryption_public_key: wallet.encryption_public_key.clone(),
        created_at: wallet.created_at.clone(),
    }
}

fn map_conversation(conversation: quantum_vault_storage::messenger_store::Conversation) -> Conversation {
    Conversation {
        id: conversation.id,
        created_by: conversation.created_by,
        participant_ids: conversation.participant_ids,
        name: conversation.name.unwrap_or_default(),
        is_group: conversation.is_group,
        created_at: conversation.created_at,
    }
}

fn map_message(message: quantum_vault_storage::messenger_store::MessengerMessage) -> MessengerMessage {
    MessengerMessage {
        id: message.id,
        conversation_id: message.conversation_id,
        sender_wallet_id: message.sender_wallet_id,
        encrypted_content: message.encrypted_content,
        signature: message.signature,
        self_destruct: message.self_destruct,
        destruct_after_seconds: message.destruct_after_seconds.unwrap_or_default(),
        created_at: message.created_at,
        is_read: message.is_read,
    }
}
