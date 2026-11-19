import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { addressFingerprint, decodeStrKeyPayload, groupAddress } from "../fingerprint";

const MARKET_CORE = "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O";
const USDC = "CA2WQQJ4OHQCLHQW6XN4BCLILGRV6V4YDYDT3GVIWXB53BTOO7EMREQH";
const DEPLOYER = "GD2NB2VUME7ECMHFHQN5M3KUZLLJF3R6Z4OFCBLE4SJNHIQHITRPQGHQ";

/** CRC-16/XMODEM, the checksum StrKey appends to every key. */
function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Re-encodes a 32-byte payload as a valid contract id (version byte 2 + crc16). */
function encodeContract(payload: Uint8Array): string {
  const versioned = new Uint8Array(33);
  versioned[0] = 2; // strkey version for contract ids
  versioned.set(payload, 1);
  const crc = crc16xmodem(versioned);
  const full = new Uint8Array(35);
  full.set(versioned);
  full[33] = crc & 0xff;
  full[34] = (crc >> 8) & 0xff;
  return base32Encode(full);
}

describe("fingerprint - three-word address fingerprints (Issue #122)", () => {
  it("gives the same address the same words", () => {
    const first = addressFingerprint(MARKET_CORE);
    const second = addressFingerprint(MARKET_CORE);
    expect(first.words).toEqual(second.words);
    expect(first.hex).toBe(second.hex);
    expect(first.words).toHaveLength(3);
  });

  it("changes all three words when the address changes", () => {
    const payload = decodeStrKeyPayload(MARKET_CORE);
    const mutated = new Uint8Array(payload);
    mutated[10] ^= 0x01; // one bit in the payload, re-encoded as a valid StrKey
    const other = addressFingerprint(encodeContract(mutated));
    expect(other.words).not.toEqual(addressFingerprint(MARKET_CORE).words);
  });

  it("supports both G account addresses and C contract ids", () => {
    expect(addressFingerprint(DEPLOYER).words).toHaveLength(3);
    expect(addressFingerprint(USDC).words).toHaveLength(3);
    expect(StrKey.isValidEd25519PublicKey(DEPLOYER)).toBe(true);
    expect(StrKey.isValidContract(MARKET_CORE)).toBe(true);
  });

  it("throws on an invalid StrKey", () => {
    expect(() => addressFingerprint("not-an-address")).toThrow();
    expect(() => addressFingerprint("CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O0")).toThrow();
  });

  it("matches the known vector for the market-core id", () => {
    const fingerprint = addressFingerprint(MARKET_CORE);
    expect(fingerprint.words).toEqual(["level", "simple", "auction"]);
    expect(fingerprint.hex).toBe(
      "80b9203ba957a755ef573070146aa72a41a8470932f121213e6f8566c7609ca1",
    );
  });

  it("groups the address into 4-character chunks", () => {
    const groups = groupAddress(MARKET_CORE);
    expect(groups.every((group) => group.length <= 4)).toBe(true);
    expect(groups.join("")).toBe(MARKET_CORE);
  });
});
