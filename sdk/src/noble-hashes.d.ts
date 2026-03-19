// Type declaration for @noble/hashes/sha2
// Required because @noble/hashes v2 package.json exports don't
// expose ./sha2 as a resolvable TypeScript subpath.
declare module "@noble/hashes/sha2" {
  export function sha256(data: Uint8Array): Uint8Array;
  export function sha512(data: Uint8Array): Uint8Array;
}
