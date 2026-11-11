# Counter — the smallest useful RougeChain contract

A shared counter. It's the starting template of the [RougeChain IDE](https://rougechain.io/ide) and
shows the parts every contract uses: storage, JSON arguments, return values, events and the caller.

| Method | Args | What it does |
|---|---|---|
| `increment` | `{"by": 5}` (optional, default 1) | Adds `by`, records the caller's `rouge1…` address, emits `incremented {"count":N,"by":B}`, returns `{"count":N}`. |
| `get` *(read)* | `{}` | Returns `{"count":N,"last_caller":"rouge1…"}` (`null` before the first increment). |

A method is any `#[no_mangle] pub extern "C" fn` with no parameters. Arguments arrive as JSON
through `host_read_args`; the result goes back through `host_set_return`. The contract is
`#![no_std]`, so it has no allocator and no dependencies — that keeps it about 2.5 KB.

```bash
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
# → target/wasm32-unknown-unknown/release/rougechain_counter.wasm (a prebuilt copy is counter.wasm)
```
