//! AMM Core Logic - Constant Product Market Maker (x * y = k)
//!
//! Implements Uniswap V2 style AMM with:
//! - Constant product formula: x * y = k
//! - 0.3% swap fee
//! - Multi-hop routing

use crate::pool_store::LiquidityPool;
use std::collections::{HashMap, VecDeque};

/// Minimum liquidity burned when creating a pool (prevents first LP manipulation)
pub const MINIMUM_LIQUIDITY: u64 = 1000;

/// Default fee rate (0.3%)
pub const DEFAULT_FEE_RATE: f64 = 0.003;

/// Fee multiplier for calculation (1000 - 3 = 997 for 0.3% fee)
pub const FEE_NUMERATOR: u64 = 997;
pub const FEE_DENOMINATOR: u64 = 1000;

/// Calculate output amount for a swap (with fee)
/// Formula: amount_out = (amount_in * 997 * reserve_out) / (reserve_in * 1000 + amount_in * 997)
pub fn get_amount_out(amount_in: u64, reserve_in: u64, reserve_out: u64) -> Option<u64> {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return None;
    }
    
    let amount_in_with_fee = amount_in as u128 * FEE_NUMERATOR as u128;
    let numerator = amount_in_with_fee * reserve_out as u128;
    let denominator = (reserve_in as u128 * FEE_DENOMINATOR as u128) + amount_in_with_fee;
    
    if denominator == 0 {
        return None;
    }
    
    Some((numerator / denominator) as u64)
}

/// Calculate input amount required for a desired output (with fee)
/// Formula: amount_in = (reserve_in * amount_out * 1000) / ((reserve_out - amount_out) * 997) + 1
pub fn get_amount_in(amount_out: u64, reserve_in: u64, reserve_out: u64) -> Option<u64> {
    if amount_out == 0 || reserve_in == 0 || reserve_out == 0 || amount_out >= reserve_out {
        return None;
    }
    
    let numerator = reserve_in as u128 * amount_out as u128 * FEE_DENOMINATOR as u128;
    let denominator = (reserve_out - amount_out) as u128 * FEE_NUMERATOR as u128;
    
    if denominator == 0 {
        return None;
    }
    
    // Round up
    Some(((numerator / denominator) + 1) as u64)
}

/// Quote the equivalent amount of token B for a given amount of token A
/// Used for adding liquidity proportionally
pub fn quote(amount_a: u64, reserve_a: u64, reserve_b: u64) -> Option<u64> {
    if amount_a == 0 || reserve_a == 0 || reserve_b == 0 {
        return None;
    }
    
    Some((amount_a as u128 * reserve_b as u128 / reserve_a as u128) as u64)
}

/// Calculate LP tokens to mint for adding liquidity
pub fn calculate_lp_mint(
    amount_a: u64,
    amount_b: u64,
    reserve_a: u64,
    reserve_b: u64,
    total_supply: u64,
) -> Option<u64> {
    if total_supply == 0 {
        // First liquidity provider
        let lp = ((amount_a as f64 * amount_b as f64).sqrt() as u64).saturating_sub(MINIMUM_LIQUIDITY);
        if lp == 0 {
            return None;
        }
        Some(lp)
    } else {
        // Subsequent liquidity providers: min(amount_a/reserve_a, amount_b/reserve_b) * total_supply
        let lp_a = (amount_a as u128 * total_supply as u128 / reserve_a as u128) as u64;
        let lp_b = (amount_b as u128 * total_supply as u128 / reserve_b as u128) as u64;
        Some(lp_a.min(lp_b))
    }
}

/// Calculate underlying tokens when removing liquidity
pub fn calculate_remove_liquidity(
    lp_amount: u64,
    reserve_a: u64,
    reserve_b: u64,
    total_supply: u64,
) -> Option<(u64, u64)> {
    if lp_amount == 0 || total_supply == 0 {
        return None;
    }
    
    let amount_a = (lp_amount as u128 * reserve_a as u128 / total_supply as u128) as u64;
    let amount_b = (lp_amount as u128 * reserve_b as u128 / total_supply as u128) as u64;
    
    if amount_a == 0 || amount_b == 0 {
        return None;
    }
    
    Some((amount_a, amount_b))
}

/// Calculate price impact of a swap
pub fn calculate_price_impact(amount_in: u64, reserve_in: u64, reserve_out: u64) -> f64 {
    if reserve_in == 0 || reserve_out == 0 {
        return 0.0;
    }
    
    // Spot price before swap
    let spot_price = reserve_out as f64 / reserve_in as f64;
    
    // Get actual output
    let amount_out = get_amount_out(amount_in, reserve_in, reserve_out).unwrap_or(0);
    if amount_out == 0 || amount_in == 0 {
        return 0.0;
    }
    
    // Execution price
    let execution_price = amount_out as f64 / amount_in as f64;
    
    // Price impact as percentage
    ((spot_price - execution_price) / spot_price * 100.0).abs()
}

/// Multi-hop swap result
#[derive(Debug, Clone)]
pub struct SwapRoute {
    pub path: Vec<String>,           // Token path: [TOKEN_IN, ..., TOKEN_OUT]
    pub amounts: Vec<u64>,           // Amount at each step
    pub pools: Vec<String>,          // Pool IDs used
    pub total_amount_out: u64,
    pub price_impact: f64,
}

/// Find the best route for a multi-hop swap
/// Uses BFS to find shortest path, then calculates amounts
pub fn find_best_route(
    token_in: &str,
    token_out: &str,
    amount_in: u64,
    pools: &[LiquidityPool],
    max_hops: usize,
) -> Option<SwapRoute> {
    if token_in == token_out {
        return None;
    }
    
    // Build adjacency graph
    let mut graph: HashMap<String, Vec<(String, String)>> = HashMap::new(); // token -> [(other_token, pool_id)]
    for pool in pools {
        graph.entry(pool.token_a.clone()).or_default().push((pool.token_b.clone(), pool.pool_id.clone()));
        graph.entry(pool.token_b.clone()).or_default().push((pool.token_a.clone(), pool.pool_id.clone()));
    }
    
    // BFS to find all paths up to max_hops
    let mut best_route: Option<SwapRoute> = None;
    let mut queue: VecDeque<(Vec<String>, Vec<String>)> = VecDeque::new(); // (path, pool_ids)
    queue.push_back((vec![token_in.to_string()], vec![]));
    
    while let Some((path, pool_ids)) = queue.pop_front() {
        let current = path.last().unwrap();
        
        if current == token_out {
            // Found a path - calculate amounts
            if let Some(route) = calculate_route_amounts(&path, &pool_ids, amount_in, pools) {
                if best_route.is_none() || route.total_amount_out > best_route.as_ref().unwrap().total_amount_out {
                    best_route = Some(route);
                }
            }
            continue;
        }
        
        if path.len() > max_hops + 1 {
            continue;
        }
        
        // Explore neighbors
        if let Some(neighbors) = graph.get(current) {
            for (next_token, pool_id) in neighbors {
                if !path.contains(next_token) {
                    let mut new_path = path.clone();
                    new_path.push(next_token.clone());
                    let mut new_pool_ids = pool_ids.clone();
                    new_pool_ids.push(pool_id.clone());
                    queue.push_back((new_path, new_pool_ids));
                }
            }
        }
    }
    
    best_route
}

/// Calculate amounts for each hop in a route
fn calculate_route_amounts(
    path: &[String],
    pool_ids: &[String],
    amount_in: u64,
    pools: &[LiquidityPool],
) -> Option<SwapRoute> {
    if path.len() < 2 || path.len() != pool_ids.len() + 1 {
        return None;
    }
    
    let pool_map: HashMap<&str, &LiquidityPool> = pools.iter().map(|p| (p.pool_id.as_str(), p)).collect();
    
    let mut amounts = vec![amount_in];
    let mut current_amount = amount_in;
    let mut total_price_impact = 0.0;
    
    for (i, pool_id) in pool_ids.iter().enumerate() {
        let pool = pool_map.get(pool_id.as_str())?;
        let token_in = &path[i];
        
        let (reserve_in, reserve_out) = pool.get_reserves(token_in)?;
        
        let impact = calculate_price_impact(current_amount, reserve_in, reserve_out);
        total_price_impact += impact;
        
        current_amount = get_amount_out(current_amount, reserve_in, reserve_out)?;
        amounts.push(current_amount);
    }
    
    Some(SwapRoute {
        path: path.to_vec(),
        amounts,
        pools: pool_ids.to_vec(),
        total_amount_out: current_amount,
        price_impact: total_price_impact,
    })
}

/// Execute a multi-hop swap and return updated pool reserves
pub fn execute_multi_hop_swap(
    path: &[String],
    amount_in: u64,
    min_amount_out: u64,
    pools: &mut [LiquidityPool],
) -> Result<u64, String> {
    if path.len() < 2 {
        return Err("Invalid swap path".to_string());
    }
    
    let mut current_amount = amount_in;
    
    for i in 0..(path.len() - 1) {
        let token_in = &path[i];
        let token_out = &path[i + 1];
        
        // Find the pool
        let pool_id = LiquidityPool::make_pool_id(token_in, token_out);
        let pool = pools.iter_mut().find(|p| p.pool_id == pool_id)
            .ok_or_else(|| format!("Pool not found: {}", pool_id))?;
        
        let (reserve_in, reserve_out) = pool.get_reserves(token_in)
            .ok_or_else(|| "Invalid token for pool".to_string())?;
        
        let amount_out = get_amount_out(current_amount, reserve_in, reserve_out)
            .ok_or_else(|| "Insufficient liquidity".to_string())?;
        
        // Update reserves
        if pool.token_a == *token_in {
            pool.reserve_a += current_amount;
            pool.reserve_b -= amount_out;
        } else {
            pool.reserve_b += current_amount;
            pool.reserve_a -= amount_out;
        }
        
        current_amount = amount_out;
    }
    
    if current_amount < min_amount_out {
        return Err(format!("Slippage exceeded: got {} but minimum was {}", current_amount, min_amount_out));
    }
    
    Ok(current_amount)
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_get_amount_out() {
        // 1000 in, 10000/10000 reserves
        let out = get_amount_out(1000, 10000, 10000).unwrap();
        // Expected: (1000 * 997 * 10000) / (10000 * 1000 + 1000 * 997) = 9970000000 / 10997000 ≈ 906
        assert!(out > 900 && out < 1000);
    }
    
    #[test]
    fn test_get_amount_in() {
        let in_amount = get_amount_in(900, 10000, 10000).unwrap();
        // Should need slightly less than 1000 input to get 900 out
        assert!(in_amount > 900 && in_amount < 1100);
    }
    
    #[test]
    fn test_quote() {
        let amount_b = quote(100, 1000, 2000).unwrap();
        assert_eq!(amount_b, 200);
    }
    
    #[test]
    fn test_calculate_lp_mint_first_provider() {
        let lp = calculate_lp_mint(10000, 10000, 0, 0, 0).unwrap();
        // sqrt(10000 * 10000) - 1000 = 10000 - 1000 = 9000
        assert_eq!(lp, 9000);
    }
    
    #[test]
    fn test_calculate_lp_mint_subsequent() {
        let lp = calculate_lp_mint(1000, 1000, 10000, 10000, 9000).unwrap();
        // min(1000/10000, 1000/10000) * 9000 = 0.1 * 9000 = 900
        assert_eq!(lp, 900);
    }
    
    #[test]
    fn test_calculate_remove_liquidity() {
        let (a, b) = calculate_remove_liquidity(900, 11000, 11000, 9900).unwrap();
        // 900 / 9900 * 11000 = 1000 each
        assert_eq!(a, 1000);
        assert_eq!(b, 1000);
    }
}
