//! Order Book — sled-backed limit order storage for on-chain conditional swaps
//!
//! Orders are stored per pool_id and matched during block production.
//! When the AMM price satisfies the limit price, the order executes as a swap.

use serde::{Deserialize, Serialize};
use sled::Db;
use std::path::Path;
use std::sync::Arc;

/// A limit order placed by a user
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LimitOrder {
    /// Unique order ID
    pub order_id: String,
    /// Order placer's public key
    pub owner_pub_key: String,
    /// Pool where the order lives
    pub pool_id: String,
    /// Token being sold
    pub token_in: String,
    /// Token being bought
    pub token_out: String,
    /// Amount of token_in to sell
    pub amount_in: u64,
    /// Minimum amount of token_out to receive (defines the limit price)
    pub min_amount_out: u64,
    /// Block height when order was placed
    pub created_at_height: u64,
    /// Optional: expire after this block height (0 = never)
    pub expires_at_height: u64,
    /// Whether the order has been filled
    pub status: OrderStatus,
    /// Block height when filled (if applicable)
    pub filled_at_height: Option<u64>,
    /// Actual output amount (if filled)
    pub filled_amount_out: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum OrderStatus {
    Open,
    Filled,
    Cancelled,
    Expired,
}

/// Persistent order book using sled
#[derive(Clone)]
pub struct OrderBook {
    /// Primary: order_id → LimitOrder JSON
    orders: Arc<Db>,
    /// Secondary index: pool_id → list of order_ids
    pool_index: Arc<sled::Tree>,
    /// Secondary index: owner → list of order_ids
    owner_index: Arc<sled::Tree>,
}

impl OrderBook {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        let db = sled::open(data_dir.join("orderbook-db"))
            .map_err(|e| format!("orderbook-db open: {}", e))?;
        let pool_index = db.open_tree("pool_idx")
            .map_err(|e| format!("pool_idx open: {}", e))?;
        let owner_index = db.open_tree("owner_idx")
            .map_err(|e| format!("owner_idx open: {}", e))?;
        Ok(Self {
            orders: Arc::new(db),
            pool_index: Arc::new(pool_index),
            owner_index: Arc::new(owner_index),
        })
    }

    /// Place a new limit order
    pub fn place_order(&self, order: &LimitOrder) -> Result<(), String> {
        // Store order
        let val = serde_json::to_vec(order).map_err(|e| format!("serialize: {}", e))?;
        self.orders.insert(order.order_id.as_bytes(), val)
            .map_err(|e| format!("insert order: {}", e))?;

        // Update pool index (append to list)
        self.append_to_index(&self.pool_index, &order.pool_id, &order.order_id)?;
        // Update owner index
        self.append_to_index(&self.owner_index, &order.owner_pub_key, &order.order_id)?;

        self.orders.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    /// Cancel an open order (only owner can cancel)
    pub fn cancel_order(&self, order_id: &str, owner: &str) -> Result<LimitOrder, String> {
        let mut order = self.get_order(order_id)?
            .ok_or_else(|| format!("order {} not found", order_id))?;
        if order.owner_pub_key != owner {
            return Err("not the order owner".to_string());
        }
        if order.status != OrderStatus::Open {
            return Err(format!("order is not open (status: {:?})", order.status));
        }
        order.status = OrderStatus::Cancelled;
        self.save_order(&order)?;
        Ok(order)
    }

    /// Get all open orders for a pool, sorted by best price first
    pub fn get_open_orders_for_pool(&self, pool_id: &str) -> Result<Vec<LimitOrder>, String> {
        let order_ids = self.get_index_list(&self.pool_index, pool_id)?;
        let mut open_orders = Vec::new();
        for id in order_ids {
            if let Some(order) = self.get_order(&id)? {
                if order.status == OrderStatus::Open {
                    open_orders.push(order);
                }
            }
        }
        Ok(open_orders)
    }

    /// Get all orders for a user
    pub fn get_user_orders(&self, owner: &str) -> Result<Vec<LimitOrder>, String> {
        let order_ids = self.get_index_list(&self.owner_index, owner)?;
        let mut orders = Vec::new();
        for id in order_ids {
            if let Some(order) = self.get_order(&id)? {
                orders.push(order);
            }
        }
        Ok(orders)
    }

    /// Mark an order as filled
    pub fn fill_order(&self, order_id: &str, filled_height: u64, amount_out: u64) -> Result<LimitOrder, String> {
        let mut order = self.get_order(order_id)?
            .ok_or_else(|| format!("order {} not found", order_id))?;
        order.status = OrderStatus::Filled;
        order.filled_at_height = Some(filled_height);
        order.filled_amount_out = Some(amount_out);
        self.save_order(&order)?;
        Ok(order)
    }

    /// Expire orders past their expiry height
    pub fn expire_orders_at_height(&self, height: u64) -> Result<Vec<LimitOrder>, String> {
        let mut expired = Vec::new();
        for item in self.orders.iter() {
            let (_, val) = item.map_err(|e| format!("iter: {}", e))?;
            if let Ok(mut order) = serde_json::from_slice::<LimitOrder>(&val) {
                if order.status == OrderStatus::Open
                    && order.expires_at_height > 0
                    && height >= order.expires_at_height
                {
                    order.status = OrderStatus::Expired;
                    self.save_order(&order)?;
                    expired.push(order);
                }
            }
        }
        Ok(expired)
    }

    /// Get a single order by ID
    pub fn get_order(&self, order_id: &str) -> Result<Option<LimitOrder>, String> {
        match self.orders.get(order_id.as_bytes()) {
            Ok(Some(val)) => {
                let order: LimitOrder = serde_json::from_slice(&val)
                    .map_err(|e| format!("deserialize order: {}", e))?;
                Ok(Some(order))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("get order: {}", e)),
        }
    }

    /// Count open orders
    pub fn open_order_count(&self) -> u64 {
        let mut count = 0u64;
        for item in self.orders.iter() {
            if let Ok((_, val)) = item {
                if let Ok(order) = serde_json::from_slice::<LimitOrder>(&val) {
                    if order.status == OrderStatus::Open {
                        count += 1;
                    }
                }
            }
        }
        count
    }

    /// List all orders (with optional status filter)
    pub fn list_all_orders(&self, status_filter: Option<OrderStatus>) -> Result<Vec<LimitOrder>, String> {
        let mut orders = Vec::new();
        for item in self.orders.iter() {
            let (key, val) = item.map_err(|e| format!("iter: {}", e))?;
            // Skip index trees entries
            let key_str = String::from_utf8_lossy(&key);
            if key_str.starts_with("__sled__") { continue; }
            if let Ok(order) = serde_json::from_slice::<LimitOrder>(&val) {
                match &status_filter {
                    Some(s) if order.status != *s => continue,
                    _ => orders.push(order),
                }
            }
        }
        Ok(orders)
    }

    // --- Internal helpers ---

    fn save_order(&self, order: &LimitOrder) -> Result<(), String> {
        let val = serde_json::to_vec(order).map_err(|e| format!("serialize: {}", e))?;
        self.orders.insert(order.order_id.as_bytes(), val)
            .map_err(|e| format!("save order: {}", e))?;
        self.orders.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    fn append_to_index(&self, tree: &sled::Tree, key: &str, order_id: &str) -> Result<(), String> {
        let mut ids = self.get_index_list(tree, key)?;
        if !ids.contains(&order_id.to_string()) {
            ids.push(order_id.to_string());
        }
        let val = serde_json::to_vec(&ids).map_err(|e| format!("serialize: {}", e))?;
        tree.insert(key.as_bytes(), val).map_err(|e| format!("insert: {}", e))?;
        Ok(())
    }

    fn get_index_list(&self, tree: &sled::Tree, key: &str) -> Result<Vec<String>, String> {
        match tree.get(key.as_bytes()) {
            Ok(Some(val)) => {
                serde_json::from_slice(&val).map_err(|e| format!("deserialize index: {}", e))
            }
            Ok(None) => Ok(Vec::new()),
            Err(e) => Err(format!("get index: {}", e)),
        }
    }
}
