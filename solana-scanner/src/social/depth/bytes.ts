/** Byte readers and codecs for decoding on-chain account data. Pure, no Node-only API. */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** Little-endian reader over a byte array; throws on any out-of-range read (no silent zeros). */
export class Reader {
  readonly bytes: Uint8Array;
  #view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number {
    return this.bytes.length;
  }
  #check(offset: number, size: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > this.bytes.length) {
      throw new RangeError(`read of ${size} byte(s) at ${offset} is outside the account data (${this.bytes.length} bytes)`);
    }
  }
  u8(offset: number): number {
    this.#check(offset, 1);
    return this.bytes[offset]!;
  }
  u16(offset: number): number {
    this.#check(offset, 2);
    return this.#view.getUint16(offset, true);
  }
  u32(offset: number): number {
    this.#check(offset, 4);
    return this.#view.getUint32(offset, true);
  }
  i32(offset: number): number {
    this.#check(offset, 4);
    return this.#view.getInt32(offset, true);
  }
  u64(offset: number): bigint {
    this.#check(offset, 8);
    return this.#view.getBigUint64(offset, true);
  }
  u128(offset: number): bigint {
    return this.u64(offset) | (this.u64(offset + 8) << 64n);
  }
  i128(offset: number): bigint {
    const v = this.u128(offset);
    return v >= 1n << 127n ? v - (1n << 128n) : v;
  }
  pubkey(offset: number): string {
    this.#check(offset, 32);
    return base58Encode(this.bytes.subarray(offset, offset + 32));
  }
  /** True when every byte in [offset, offset+length) is zero. */
  allZero(offset: number, length: number): boolean {
    this.#check(offset, length);
    for (let i = offset; i < offset + length; i++) if (this.bytes[i] !== 0) return false;
    return true;
  }
  /** Bytes remaining from offset; a shorter-than-current-layout account reads missing trailing fields as absent. */
  has(offset: number, size: number): boolean {
    return offset >= 0 && offset + size <= this.bytes.length;
  }
}
