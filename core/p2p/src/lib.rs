use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;

use quantum_vault_types::{BlockV1, TxV1, VoteMessage};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerEndpoint {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum P2PMessage {
    Hello {
        node_id: String,
        chain_id: String,
        height: u64,
        listen_host: String,
        listen_port: u16,
    },
    GetTip,
    Tip { height: u64, hash: String },
    GetBlock { height: u64 },
    Block { block: BlockV1 },
    Tx { tx: TxV1 },
    Vote { vote: VoteMessage },
    Peers { peers: Vec<PeerEndpoint> },
}

pub struct TcpPeer {
    _stream: TcpStream,
}

impl TcpPeer {
    pub async fn connect(_endpoint: &PeerEndpoint) -> Result<Self, String> {
        Err("tcp peer not implemented".to_string())
    }
}
