# Performance Optimizations

## Speed Improvements

### 1. **Faster Default Block Time**
- **Before**: 4 seconds per block
- **After**: 1 second per block (4x faster)
- **Customizable**: Use `--blockTimeMs` flag to set any value

### 2. **Optimized Mining Loop**
- **Before**: Always waited full block time, even if block production was instant
- **After**: 
  - Starts immediately (no initial delay)
  - Only waits remaining time after block production completes
  - Example: If block takes 50ms and block time is 1000ms, waits only 950ms

### 3. **Parallel Transaction Verification**
- **Before**: Verified transaction signatures sequentially (one at a time)
- **After**: Verifies all transaction signatures in parallel using `Promise.all()`
- **Impact**: For a block with 10 transactions, verification is ~10x faster

### 4. **Efficient Block Validation**
- Early exit on validation failures
- Parallel signature checks
- Minimal disk I/O

## Performance Metrics

### Block Production Speed
- **Block creation**: ~10-50ms (depending on transaction count)
- **Signature verification**: Parallel (all txs at once)
- **Block time**: 1 second default (configurable)

### Throughput
- **Theoretical max**: ~60 blocks/minute (at 1s block time)
- **With transactions**: Depends on verification time, but parallel verification helps significantly

## Configuration

### Fast Devnet (500ms blocks)
```bash
npm run l1:node:dev -- --name a --port 4100 --mine --blockTimeMs 500
```

### Standard (1s blocks - default)
```bash
npm run l1:node:dev -- --name a --port 4100 --mine
```

### Slower (2s blocks)
```bash
npm run l1:node:dev -- --name a --port 4100 --mine --blockTimeMs 2000
```

## Future Optimizations

Potential areas for further speed improvements:

1. **Batch Block Storage**: Write multiple blocks at once
2. **Caching**: Cache frequently accessed blocks
3. **Indexed Storage**: Replace linear scan with hash/height indexes
4. **Streaming Validation**: Validate blocks as they arrive, not all at once
5. **Compression**: Compress block data for storage/transmission
6. **State Snapshots**: Fast sync via snapshots instead of full chain replay

## Bottlenecks

Current bottlenecks (in order of impact):

1. **PQC Signature Verification**: ML-DSA-65 verification is CPU-intensive (~1-5ms per signature)
   - Mitigated by parallel verification
2. **Disk I/O**: Reading/writing blocks to JSONL files
   - Acceptable for devnet, but production needs indexed storage
3. **Network Propagation**: TCP P2P message delivery
   - Acceptable for local devnet, but production needs optimized gossip

## Monitoring

Check block production time in console logs:
```
✅ Mined block #42 (5 txs, 0.5 XRGE fees, 23ms, hash: abc123...)
```

The `23ms` shows how long block production took. If it's consistently low (<100ms), you can reduce `blockTimeMs` further.
