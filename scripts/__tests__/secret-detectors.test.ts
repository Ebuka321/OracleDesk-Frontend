import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  findEvmKeys,
  findHighEntropy,
  findJwts,
  findPublicEnvNames,
  findStellarSeeds,
} from "../lib/secret-detectors.mjs";
import { allowedEnvNames, allowedValueHashes } from "../scan-build-secrets.mjs";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("secret detectors", () => {
  it("detects a checksum-valid Stellar secret seed", () => {
    const seed = Keypair.random().secret();
    expect(findStellarSeeds(`const k = "${seed}";`)).toHaveLength(1);
  });

  it("ignores S-prefixed base32 with a bad checksum", () => {
    const seed = Keypair.random().secret();
    const broken = `${seed.slice(0, -1)}A`;
    expect(findStellarSeeds(broken)).toEqual([]);
  });

  it("ignores G and C StrKeys", () => {
    const text =
      "GD2NB2VUME7ECMHFHQN5M3KUZLLJF3R6Z4OFCBLE4SJNHIQHITRPQGHQ CA2WQQJ4OHQCLHQW6XN4BCLILGRV6V4YDYDT3GVIWXB53BTOO7EMREQH";
    expect(findStellarSeeds(text)).toEqual([]);
  });

  it("detects an EVM private key near a key word", () => {
    expect(findEvmKeys(`const PRIVATE_KEY = "0x${"a".repeat(64)}"`)).toHaveLength(1);
  });

  it("ignores an EVM address and a bare 64-hex trace hash", () => {
    expect(findEvmKeys(`const to = "0x${"a".repeat(40)}"`)).toEqual([]);
    expect(findEvmKeys(`const tx = "${"b".repeat(64)}"`)).toEqual([]);
  });

  it("detects a JWT whose header declares alg", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    expect(findJwts(`${header}.${"a".repeat(16)}.${"b".repeat(16)}`)).toHaveLength(1);
  });

  it("skips allowlisted high-entropy values", () => {
    const token = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
    expect(findHighEntropy(token)).toHaveLength(1);
    expect(findHighEntropy(token, { allowed: new Set([hash(token)]), createHash: hash } as never)).toHaveLength(0);
  });

  it("extracts NEXT_PUBLIC names", () => {
    expect([...findPublicEnvNames('process.env.NEXT_PUBLIC_API_URL + "NEXT_PUBLIC_OTHER"')].sort()).toEqual([
      "NEXT_PUBLIC_API_URL",
      "NEXT_PUBLIC_OTHER",
    ]);
  });
});

describe("scanner allowlists", () => {
  it("parses names from .env.example", () => {
    const names = allowedEnvNames("# comment\nNEXT_PUBLIC_API_URL=x\nNEXT_PUBLIC_RPC_URL=\nSECRET=1\n");
    expect([...names]).toEqual(["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_RPC_URL"]);
  });

  it("hashes public deployment values", () => {
    const values = allowedValueHashes({ deployer: "GABC", contracts: { usdc: "CXYZ" } });
    expect(values.has(hash("GABC"))).toBe(true);
    expect(values.has(hash("CXYZ"))).toBe(true);
  });
});
