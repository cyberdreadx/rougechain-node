extern crate alloc;

use alloc::vec::Vec;
use core::cell::UnsafeCell;

struct OutputBuf(UnsafeCell<Vec<u8>>);
unsafe impl Sync for OutputBuf {}

static OUTPUT_BUF: OutputBuf = OutputBuf(UnsafeCell::new(Vec::new()));

/// Allocate `len` bytes in WASM linear memory.
/// Returns a pointer the host can write into.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len);
    buf.resize(len, 0u8);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Free a previously allocated buffer.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, len, len));
}

/// Generate a STARK proof for unshield.
///
/// Arguments: `amount` and `fee` (both u64).
/// On success, writes the hex-encoded proof into the internal output buffer
/// and returns its length. On failure returns 0.
#[no_mangle]
pub extern "C" fn prove_unshield(amount: u64, fee: u64) -> u32 {
    let input_value = amount + fee;
    match quantum_vault_crypto::stark::prove_shielded_transfer(input_value, amount, 0, fee) {
        Ok((proof, _)) => {
            let hex_bytes = hex::encode(proof.to_bytes()).into_bytes();
            let len = hex_bytes.len() as u32;
            unsafe {
                *OUTPUT_BUF.0.get() = hex_bytes;
            }
            len
        }
        Err(_) => 0,
    }
}

/// Return a pointer to the output buffer populated by `prove_unshield`.
#[no_mangle]
pub extern "C" fn get_output_ptr() -> *const u8 {
    unsafe { (*OUTPUT_BUF.0.get()).as_ptr() }
}
