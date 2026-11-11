//! Counter — the smallest useful RougeChain contract.
//!
//! - `increment {"by": 5}` adds `by` (default 1) to a shared counter, remembers who called last,
//!   emits `incremented {"count":N,"by":B}` and returns `{"count":N}`.
//! - `get {}` (read-only) returns `{"count":N,"last_caller":"rouge1…"}`.
//!
//! A method is any `#[no_mangle] pub extern "C" fn` with no parameters: the caller's JSON arguments
//! are read with `host_read_args`, the result is set with `host_set_return`. Storage is a key/value
//! map private to the contract. Build: `cargo build --release --target wasm32-unknown-unknown`.

#![no_std]

use core::panic::PanicInfo;

extern "C" {
    fn host_get_caller(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_pqc_pubkey_to_address(pk_ptr: *const u8, pk_len: u32, out_ptr: *mut u8, out_len: u32) -> i32;
    fn host_read_args(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_storage_read(key_ptr: *const u8, key_len: u32, val_ptr: *mut u8, val_len: u32) -> i32;
    fn host_storage_write(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32);
    fn host_emit_event(topic_ptr: *const u8, topic_len: u32, data_ptr: *const u8, data_len: u32);
    fn host_set_return(data_ptr: *const u8, data_len: u32);
}

const COUNT: &[u8] = b"count";
const LAST: &[u8] = b"last_caller";

#[no_mangle]
pub extern "C" fn increment() {
    let mut args = [0u8; 256];
    let n = unsafe { host_read_args(args.as_mut_ptr(), args.len() as u32) };
    let by = if n > 0 { number_field(&args[..n as usize], b"\"by\"").unwrap_or(1) } else { 1 };

    let count = read_u64(COUNT).saturating_add(by);
    unsafe { host_storage_write(COUNT.as_ptr(), COUNT.len() as u32, count.to_be_bytes().as_ptr(), 8) };

    // The caller is a wallet's public key (hex); store its rouge1 address.
    let mut caller = [0u8; 4096];
    let c = unsafe { host_get_caller(caller.as_mut_ptr(), caller.len() as u32) };
    if c > 0 {
        let mut pk = [0u8; 1952];
        if let Some(len) = hex_decode(&caller[..c as usize], &mut pk) {
            let mut addr = [0u8; 128];
            let a = unsafe { host_pqc_pubkey_to_address(pk.as_ptr(), len as u32, addr.as_mut_ptr(), addr.len() as u32) };
            if a > 0 {
                unsafe { host_storage_write(LAST.as_ptr(), LAST.len() as u32, addr.as_ptr(), a as u32) };
            }
        }
    }

    let mut out = Json::new();
    out.raw(b"{\"count\":").num(count).raw(b",\"by\":").num(by).raw(b"}");
    let topic = b"incremented";
    unsafe { host_emit_event(topic.as_ptr(), topic.len() as u32, out.as_ptr(), out.len() as u32) };

    let mut ret = Json::new();
    ret.raw(b"{\"count\":").num(count).raw(b"}");
    unsafe { host_set_return(ret.as_ptr(), ret.len() as u32) };
}

#[no_mangle]
pub extern "C" fn get() {
    let mut last = [0u8; 128];
    let l = unsafe { host_storage_read(LAST.as_ptr(), LAST.len() as u32, last.as_mut_ptr(), last.len() as u32) };
    let mut ret = Json::new();
    ret.raw(b"{\"count\":").num(read_u64(COUNT)).raw(b",\"last_caller\":");
    if l > 0 {
        ret.raw(b"\"").raw(&last[..l as usize]).raw(b"\"");
    } else {
        ret.raw(b"null");
    }
    ret.raw(b"}");
    unsafe { host_set_return(ret.as_ptr(), ret.len() as u32) };
}

fn read_u64(key: &[u8]) -> u64 {
    let mut buf = [0u8; 8];
    let n = unsafe { host_storage_read(key.as_ptr(), key.len() as u32, buf.as_mut_ptr(), 8) };
    if n == 8 { u64::from_be_bytes(buf) } else { 0 }
}

/// The unsigned integer after `"name":` in a flat JSON object, if any.
fn number_field(json: &[u8], name: &[u8]) -> Option<u64> {
    let start = json.windows(name.len()).position(|w| w == name)? + name.len();
    let mut i = start;
    while i < json.len() && (json[i] == b' ' || json[i] == b':') {
        i += 1;
    }
    let mut v: u64 = 0;
    let mut digits = 0;
    while i < json.len() && json[i].is_ascii_digit() {
        v = v.checked_mul(10)?.checked_add((json[i] - b'0') as u64)?;
        i += 1;
        digits += 1;
    }
    if digits > 0 { Some(v) } else { None }
}

fn hex_decode(src: &[u8], out: &mut [u8]) -> Option<usize> {
    if src.len() % 2 != 0 || src.len() / 2 > out.len() {
        return None;
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    for i in 0..src.len() / 2 {
        out[i] = (nib(src[2 * i])? << 4) | nib(src[2 * i + 1])?;
    }
    Some(src.len() / 2)
}

/// A fixed-size JSON writer (no allocator in `no_std`).
struct Json {
    buf: [u8; 256],
    len: usize,
}

impl Json {
    fn new() -> Self {
        Json { buf: [0; 256], len: 0 }
    }
    fn raw(&mut self, s: &[u8]) -> &mut Self {
        let n = s.len().min(self.buf.len() - self.len);
        self.buf[self.len..self.len + n].copy_from_slice(&s[..n]);
        self.len += n;
        self
    }
    fn num(&mut self, mut v: u64) -> &mut Self {
        let mut digits = [0u8; 20];
        let mut i = digits.len();
        loop {
            i -= 1;
            digits[i] = b'0' + (v % 10) as u8;
            v /= 10;
            if v == 0 {
                break;
            }
        }
        let d = digits;
        self.raw(&d[i..])
    }
    fn as_ptr(&self) -> *const u8 {
        self.buf.as_ptr()
    }
    fn len(&self) -> usize {
        self.len
    }
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
