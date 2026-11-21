import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  ADMIN_ADDRESSES,
  CONTRACTS,
  TESTNET_PASSPHRASE,
} from "../config";
import {
  verifyTreasuryOperation,
  verifySignedEnvelopeMatches,
  expectedContractForKind,
  expectedFunctionForKind,
} from "../treasury-decoder";
import {
  calculateCollectedWeight,
  isOperationReady,
  type TreasuryOperationRecord,
} from "@/lib/api/treasury-admin";

const admin = ADMIN_ADDRESSES[0];
const dummyRecipient = Keypair.random().publicKey();

function buildMockTx(opts: {
  source?: string;
  contractId?: string;
  fnName?: string;
  args?: xdr.ScVal[];
  fee?: string;
  maxTime?: number;
  networkPassphrase?: string;
  extraOp?: boolean;
}) {
  const source = opts.source ?? admin;
  const contractId = opts.contractId ?? CONTRACTS.treasury;
  const fnName = opts.fnName ?? "withdraw";
  const args = opts.args ?? [
    new Address(dummyRecipient).toScVal(),
    nativeToScVal(50000000n, { type: "i128" }),
  ];
  const maxTime = opts.maxTime ?? Math.floor(Date.now() / 1000) + 3600;
  const networkPassphrase = opts.networkPassphrase ?? TESTNET_PASSPHRASE;

  const account = new Account(source, "100");
  const builder = new TransactionBuilder(account, {
    fee: opts.fee ?? "100",
    networkPassphrase,
    timebounds: { minTime: 0, maxTime },
  });

  builder.addOperation(
    Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contractId).toScAddress(),
          functionName: fnName,
          args,
        })
      ),
      auth: [],
    })
  );

  if (opts.extraOp) {
    builder.addOperation(
      Operation.payment({
        destination: dummyRecipient,
        asset: xdr.Asset.assetTypeNative(),
        amount: "10",
      })
    );
  }

  const tx = builder.build();
  return {
    tx,
    xdr: tx.toXDR(),
    hash: tx.hash().toString("hex"),
  };
}

describe("Treasury Operations Decoder & Verifier", () => {
  describe("Valid Cases for All 5 Operations", () => {
    it("verifies treasury.set_paused", () => {
      const mock = buildMockTx({
        contractId: CONTRACTS.treasury,
        fnName: "set_paused",
        args: [nativeToScVal(true, { type: "bool" })],
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        { kind: "treasury.set_paused", paused: true, adminAddress: admin },
        mock.hash
      );
      expect(res.valid).toBe(true);
      expect(res.decoded?.functionName).toBe("set_paused");
      expect(res.decoded?.contractId).toBe(CONTRACTS.treasury);
    });

    it("verifies treasury.withdraw", () => {
      const mock = buildMockTx({
        contractId: CONTRACTS.treasury,
        fnName: "withdraw",
        args: [
          new Address(dummyRecipient).toScVal(),
          nativeToScVal(100000000n, { type: "i128" }),
        ],
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient,
          amountRaw: 100000000n,
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(true);
      expect(res.decoded?.decodedArgs.recipient).toBe(dummyRecipient);
      expect(res.decoded?.decodedArgs.amount).toBe(100000000n);
    });

    it("verifies treasury.deposit (source account equals from address)", () => {
      const depositor = admin;
      const mock = buildMockTx({
        source: depositor,
        contractId: CONTRACTS.treasury,
        fnName: "deposit",
        args: [
          new Address(depositor).toScVal(),
          nativeToScVal(50000000n, { type: "i128" }),
        ],
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.deposit",
          from: depositor,
          amountRaw: 50000000n,
        },
        mock.hash
      );
      expect(res.valid).toBe(true);
      expect(res.decoded?.decodedArgs.from).toBe(depositor);
      expect(res.decoded?.sourceAccount).toBe(depositor);
    });

    it("verifies treasury.collect_market_fees", () => {
      const mock = buildMockTx({
        contractId: CONTRACTS.treasury,
        fnName: "collect_market_fees",
        args: [nativeToScVal([1n, 2n, 3n], { type: "vec" })],
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.collect_market_fees",
          marketIds: [1n, 2n, 3n],
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(true);
      expect(res.decoded?.decodedArgs.marketIds).toEqual([1n, 2n, 3n]);
    });

    it("verifies market_core.set_paused", () => {
      const mock = buildMockTx({
        contractId: CONTRACTS.marketCore,
        fnName: "set_paused",
        args: [nativeToScVal(false, { type: "bool" })],
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        { kind: "market_core.set_paused", paused: false, adminAddress: admin },
        mock.hash
      );
      expect(res.valid).toBe(true);
      expect(res.decoded?.contractId).toBe(CONTRACTS.marketCore);
      expect(res.decoded?.functionName).toBe("set_paused");
    });
  });

  describe("Tamper Cases (Strict Verification Rejections)", () => {
    it("rejects different destination in withdraw", () => {
      const otherRecipient = Keypair.random().publicKey();
      const mock = buildMockTx({
        fnName: "withdraw",
        args: [
          new Address(otherRecipient).toScVal(),
          nativeToScVal(100n, { type: "i128" }),
        ],
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient, // Expects dummyRecipient
          amountRaw: 100n,
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/Argument 'recipient'/i);
    });

    it("rejects different amount", () => {
      const mock = buildMockTx({
        fnName: "withdraw",
        args: [
          new Address(dummyRecipient).toScVal(),
          nativeToScVal(999999n, { type: "i128" }), // Different amount
        ],
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient,
          amountRaw: 100000n,
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/Argument 'amount'/i);
    });

    it("rejects different function name", () => {
      const mock = buildMockTx({
        fnName: "deposit", // Backend prepared deposit instead of withdraw
        args: [
          new Address(dummyRecipient).toScVal(),
          nativeToScVal(100n, { type: "i128" }),
        ],
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient,
          amountRaw: 100n,
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/Function name/i);
    });

    it("rejects different target contract ID", () => {
      const hostileContract = Keypair.random().publicKey();
      const mock = buildMockTx({
        contractId: hostileContract,
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient,
          amountRaw: 50000000n,
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/Target contract/i);
    });

    it("rejects wrong network passphrase", () => {
      const mock = buildMockTx({
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient,
          amountRaw: 50000000n,
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/passphrase mismatch/i);
    });

    it("rejects multiple / extra operations", () => {
      const mock = buildMockTx({ extraOp: true });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient,
          amountRaw: 50000000n,
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/Expected exactly 1 operation/i);
    });

    it("rejects expired time bounds", () => {
      const mock = buildMockTx({
        maxTime: Math.floor(Date.now() / 1000) - 100, // In the past
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient,
          amountRaw: 50000000n,
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/expired/i);
    });

    it("rejects wrong / unauthorized source account", () => {
      const randomKey = Keypair.random().publicKey();
      const mock = buildMockTx({
        source: randomKey,
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient,
          amountRaw: 50000000n,
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/source account/i);
    });

    it("rejects excessive transaction fee", () => {
      const mock = buildMockTx({
        fee: "50000000", // 5 XLM (exceeds 10,000,000 stroops sane limit)
      });
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient,
          amountRaw: 50000000n,
          adminAddress: admin,
        },
        mock.hash
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/Fee of .* exceeds maximum sane threshold/i);
    });

    it("rejects hash mismatch", () => {
      const mock = buildMockTx({});
      const fakeHash = "0".repeat(64);
      const res = verifyTreasuryOperation(
        mock.xdr,
        {
          kind: "treasury.withdraw",
          recipient: dummyRecipient,
          amountRaw: 50000000n,
          adminAddress: admin,
        },
        fakeHash
      );
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/Transaction hash mismatch/i);
    });

    it("rejects signed XDR with a modified transaction body", () => {
      const original = buildMockTx({
        fnName: "withdraw",
        args: [new Address(dummyRecipient).toScVal(), nativeToScVal(100n, { type: "i128" })],
      });
      const tampered = buildMockTx({
        fnName: "withdraw",
        args: [new Address(dummyRecipient).toScVal(), nativeToScVal(200n, { type: "i128" })],
      });

      // Sign the tampered one
      const kp = Keypair.random();
      tampered.tx.sign(kp);

      const check = verifySignedEnvelopeMatches(original.xdr, tampered.tx.toXDR());
      expect(check.valid).toBe(false);
      expect(check.reason).toMatch(/modified transaction/i);
    });
  });

  describe("Weight & Threshold Disagreement Logic", () => {
    it("respects backend HIGH threshold requirement as authority over medium threshold", () => {
      const requiredSigners = [
        { key: "G1", weight: 10 },
        { key: "G2", weight: 10 },
        { key: "G3", weight: 10 },
      ];

      const op: TreasuryOperationRecord = {
        id: "op-1",
        kind: "treasury.withdraw",
        xdr: "",
        hash: "",
        networkPassphrase: TESTNET_PASSPHRASE,
        sourceAccount: admin,
        humanSummary: "Withdraw funds",
        validUntil: 2000000000,
        expiresAt: 2000000000000,
        fee: "100",
        status: "SIGNING",
        signatures: [
          { signer: "G1", weight: 10, hint: "hint1" },
          { signer: "G2", weight: 10, hint: "hint2" },
        ],
        requiredSigners,
        requiredThreshold: 30, // Backend HIGH threshold is 30, whereas medium might be 20
        collectedWeight: 20,
        createdAt: 1000,
      };

      // Collected weight is 20
      const collected = calculateCollectedWeight(op.signatures, op.requiredSigners);
      expect(collected).toBe(20);

      // Backend high threshold is 30: must NOT be ready even though medium (20) was met
      expect(isOperationReady(op)).toBe(false);

      // Add third signature (now weight = 30)
      op.signatures.push({ signer: "G3", weight: 10, hint: "hint3" });
      expect(isOperationReady(op)).toBe(true);
    });
  });
});
