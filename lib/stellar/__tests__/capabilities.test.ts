import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { fnCompatible, indexSpec } from "../capabilities";
import { CAPABILITIES, pickBuyEntrypoint, resolveCapabilities } from "../capability-registry";
import { capabilityCacheKey, stripDoc } from "../contract-check";
import { assertCanWrite } from "../write-guard";
import capabilitySpecs from "../generated/capability-specs.json";

const SIGNER = {
  publicKey: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  signTransaction: async (tx: string) => ({ signedTxXdr: tx }),
};

const U32 = xdr.ScSpecTypeDef.scSpecTypeU32();
const U64 = xdr.ScSpecTypeDef.scSpecTypeU64();
const I128 = xdr.ScSpecTypeDef.scSpecTypeI128();
const ADDR = xdr.ScSpecTypeDef.scSpecTypeAddress();
const udt = (name: string) => xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name }));

function makeFnEntry(
  name: string,
  inputs: { name: string; type: xdr.ScSpecTypeDef }[],
  outputs: xdr.ScSpecTypeDef[] = [],
  doc = "",
): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc,
      name,
      inputs: inputs.map(
        (i) => new xdr.ScSpecFunctionInputV0({ doc: "", name: i.name, type: i.type }),
      ),
      outputs,
    }),
  );
}

function buildMarketCoreFixtureSpec(): xdr.ScSpecEntry[] {
  const marketStruct = xdr.ScSpecEntry.scSpecEntryUdtStructV0(
    new xdr.ScSpecUdtStructV0({
      doc: "",
      lib: "",
      name: "Market",
      fields: [
        new xdr.ScSpecUdtStructFieldV0({ doc: "", name: "fee_bps", type: U32 }),
        new xdr.ScSpecUdtStructFieldV0({ doc: "", name: "reserve_yes", type: I128 }),
      ],
    }),
  );
  const errorEnum = xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
    new xdr.ScSpecUdtErrorEnumV0({
      doc: "",
      lib: "",
      name: "Error",
      cases: [
        new xdr.ScSpecUdtErrorEnumCaseV0({ doc: "", name: "NotInitialized", value: 1 }),
        new xdr.ScSpecUdtErrorEnumCaseV0({ doc: "", name: "Paused", value: 2 }),
      ],
    }),
  );
  const coreFns = CAPABILITIES["marketCore.core"].fns.map((name) =>
    name === "buy"
      ? makeFnEntry("buy", [
          { name: "trader", type: ADDR },
          { name: "market_id", type: U64 },
          { name: "collateral_in", type: I128 },
        ], [I128])
      : name === "get_market"
        ? makeFnEntry("get_market", [{ name: "market_id", type: U64 }], [udt("Market")])
        : makeFnEntry(name, [{ name: "market_id", type: U64 }], [I128]),
  );
  const optionalFns = [
    ...CAPABILITIES["marketCore.buyV2"].fns,
    ...CAPABILITIES["marketCore.splitMerge"].fns,
  ].map((name) => makeFnEntry(name, [{ name: "market_id", type: U64 }], [I128]));

  return [marketStruct, errorEnum, ...coreFns, ...optionalFns];
}

describe("Contract capabilities", () => {
  it("capability-specs.json contains entries for all 4 contracts and CAPABILITIES registry is non-empty", () => {
    expect(Object.keys(capabilitySpecs).sort()).toEqual([
      "marketCore",
      "reasoningRegistry",
      "resolver",
      "treasury",
    ]);
    for (const [, entries] of Object.entries(capabilitySpecs)) {
      expect((entries as string[]).length).toBeGreaterThan(0);
    }
  });

  it("old market-core spec (without buy_v2/split/merge): core ok, buyV2/splitMerge false", () => {
    const bundled = buildMarketCoreFixtureSpec();
    const optionalFns = new Set(["buy_v2", "sell_v2", "split", "merge"]);
    const oldOnChain = bundled.filter((e) => {
      if (e.arm() !== "functionV0") return true;
      const fnName = (e.value() as xdr.ScSpecFunctionV0).name().toString();
      return !optionalFns.has(fnName);
    });

    const caps = resolveCapabilities("marketCore", oldOnChain, bundled);
    expect(caps["marketCore.core"]).toEqual({ ok: true });
    expect(caps["marketCore.buyV2"]?.ok).toBe(false);
    expect(caps["marketCore.splitMerge"]?.ok).toBe(false);
  });

  it("new spec: all bundled capabilities true", () => {
    const bundled = buildMarketCoreFixtureSpec();
    const caps = resolveCapabilities("marketCore", bundled, bundled);
    expect(caps["marketCore.core"]).toEqual({ ok: true });
    expect(caps["marketCore.buyV2"]).toEqual({ ok: true });
    expect(caps["marketCore.splitMerge"]).toEqual({ ok: true });
  });

  it("buy with an extra arg is incompatible with reason naming the arg", () => {
    const bundled = buildMarketCoreFixtureSpec();
    const onChain = bundled.map((e) => {
      if (e.arm() !== "functionV0") return e;
      const fn = e.value() as xdr.ScSpecFunctionV0;
      if (fn.name().toString() !== "buy") return e;
      return xdr.ScSpecEntry.scSpecEntryFunctionV0(
        new xdr.ScSpecFunctionV0({
          doc: "",
          name: "buy",
          inputs: [
            ...fn.inputs(),
            new xdr.ScSpecFunctionInputV0({ doc: "", name: "extra_flag", type: U32 }),
          ],
          outputs: fn.outputs(),
        }),
      );
    });

    const caps = resolveCapabilities("marketCore", onChain, bundled);
    expect(caps["marketCore.core"]?.ok).toBe(false);
    if (!caps["marketCore.core"]?.ok) {
      expect(caps["marketCore.core"]?.reason).toContain("extra_flag");
    }
  });

  it("struct field type change in Market makes marketCore.core fail", () => {
    const bundled = buildMarketCoreFixtureSpec();
    const onChain = bundled.map((e) => {
      if (e.arm() !== "udtStructV0") return e;
      const st = e.value() as xdr.ScSpecUdtStructV0;
      if (st.name().toString() !== "Market") return e;
      return xdr.ScSpecEntry.scSpecEntryUdtStructV0(
        new xdr.ScSpecUdtStructV0({
          doc: "",
          lib: st.lib(),
          name: st.name(),
          fields: st.fields().map((f, idx) =>
            idx === 0
              ? new xdr.ScSpecUdtStructFieldV0({ doc: "", name: f.name(), type: U64 })
              : f,
          ),
        }),
      );
    });

    const caps = resolveCapabilities("marketCore", onChain, bundled);
    expect(caps["marketCore.core"]?.ok).toBe(false);
    if (!caps["marketCore.core"]?.ok) {
      expect(caps["marketCore.core"]?.reason).toContain("Market.fee_bps");
    }
  });

  it("error enum adds codes -> ok; renumbers a mapped code -> core fail", () => {
    const bundled = buildMarketCoreFixtureSpec();
    const addedOnChain = bundled.map((e) => {
      if (e.arm() !== "udtErrorEnumV0") return e;
      const er = e.value() as xdr.ScSpecUdtErrorEnumV0;
      return xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
        new xdr.ScSpecUdtErrorEnumV0({
          doc: "",
          lib: er.lib(),
          name: er.name(),
          cases: [
            ...er.cases(),
            new xdr.ScSpecUdtErrorEnumCaseV0({ doc: "", name: "BrandNewError", value: 999 }),
          ],
        }),
      );
    });
    expect(resolveCapabilities("marketCore", addedOnChain, bundled)["marketCore.core"]).toEqual({ ok: true });

    const renumberedOnChain = bundled.map((e) => {
      if (e.arm() !== "udtErrorEnumV0") return e;
      const er = e.value() as xdr.ScSpecUdtErrorEnumV0;
      return xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
        new xdr.ScSpecUdtErrorEnumV0({
          doc: "",
          lib: er.lib(),
          name: er.name(),
          cases: er.cases().map((c) =>
            c.value() === 1
              ? new xdr.ScSpecUdtErrorEnumCaseV0({ doc: "", name: c.name(), value: 998 })
              : c,
          ),
        }),
      );
    });
    expect(resolveCapabilities("marketCore", renumberedOnChain, bundled)["marketCore.core"]?.ok).toBe(false);
  });

  it("doc-only changes and entry order do not affect results", () => {
    const bundled = buildMarketCoreFixtureSpec();
    const strippedReversed = [...bundled].reverse().map(stripDoc);
    const caps = resolveCapabilities("marketCore", strippedReversed, bundled);
    expect(caps["marketCore.core"]).toEqual({ ok: true });
  });

  it("UnionV0 order does not matter, while EnumV0 order does", () => {
    const fn = makeFnEntry("check", [{ name: "u", type: udt("MyUnion") }, { name: "e", type: udt("MyEnum") }]);
    const unionA = xdr.ScSpecEntry.scSpecEntryUdtUnionV0(
      new xdr.ScSpecUdtUnionV0({
        doc: "",
        lib: "",
        name: "MyUnion",
        cases: [
          xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(new xdr.ScSpecUdtUnionCaseVoidV0({ doc: "", name: "Yes" })),
          xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(new xdr.ScSpecUdtUnionCaseVoidV0({ doc: "", name: "No" })),
        ],
      }),
    );
    const unionB = xdr.ScSpecEntry.scSpecEntryUdtUnionV0(
      new xdr.ScSpecUdtUnionV0({
        doc: "",
        lib: "",
        name: "MyUnion",
        cases: [
          xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(new xdr.ScSpecUdtUnionCaseVoidV0({ doc: "", name: "No" })),
          xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(new xdr.ScSpecUdtUnionCaseVoidV0({ doc: "", name: "Yes" })),
        ],
      }),
    );
    const enumA = xdr.ScSpecEntry.scSpecEntryUdtEnumV0(
      new xdr.ScSpecUdtEnumV0({
        doc: "",
        lib: "",
        name: "MyEnum",
        cases: [
          new xdr.ScSpecUdtEnumCaseV0({ doc: "", name: "A", value: 0 }),
          new xdr.ScSpecUdtEnumCaseV0({ doc: "", name: "B", value: 1 }),
        ],
      }),
    );
    const enumB = xdr.ScSpecEntry.scSpecEntryUdtEnumV0(
      new xdr.ScSpecUdtEnumV0({
        doc: "",
        lib: "",
        name: "MyEnum",
        cases: [
          new xdr.ScSpecUdtEnumCaseV0({ doc: "", name: "B", value: 1 }),
          new xdr.ScSpecUdtEnumCaseV0({ doc: "", name: "A", value: 0 }),
        ],
      }),
    );

    const bIdx = indexSpec([fn, unionA, enumA]);
    const reorderedUnionOnly = indexSpec([fn, unionB, enumA]);
    const reorderedEnum = indexSpec([fn, unionB, enumB]);

    expect(fnCompatible(bIdx.fns.get("check")!, reorderedUnionOnly, bIdx)).toEqual({ ok: true });
    expect(fnCompatible(bIdx.fns.get("check")!, reorderedEnum, bIdx).ok).toBe(false);
  });

  it("recursive UDT does not loop", () => {
    const nodeType = xdr.ScSpecTypeDef.scSpecTypeOption(
      new xdr.ScSpecTypeOption({
        valueType: udt("Node"),
      }),
    );
    const nodeStruct = xdr.ScSpecEntry.scSpecEntryUdtStructV0(
      new xdr.ScSpecUdtStructV0({
        doc: "",
        lib: "",
        name: "Node",
        fields: [new xdr.ScSpecUdtStructFieldV0({ doc: "", name: "next", type: nodeType })],
      }),
    );
    const fn = makeFnEntry("walk", [{ name: "root", type: udt("Node") }]);
    const idx = indexSpec([fn, nodeStruct]);
    expect(fnCompatible(idx.fns.get("walk")!, idx, idx)).toEqual({ ok: true });
  });

  it("cache key includes build id", () => {
    expect(capabilityCacheKey("abc", "build-1")).not.toBe(capabilityCacheKey("abc", "build-2"));
  });

  it("assertCanWrite with requires: ['marketCore.buyV2'] throws kind contract when missing", () => {
    expect(() =>
      assertCanWrite({
        signer: SIGNER,
        isWrongNetwork: false,
        target: "marketCore",
        requires: ["marketCore.buyV2"],
        integrity: {
          marketCore: {
            contract: "marketCore",
            id: "C1",
            status: "compatible",
            checkedAtLedger: 1,
            capabilities: {
              "marketCore.core": { ok: true },
              "marketCore.buyV2": { ok: false, reason: "missing" },
            },
          },
        },
      }),
    ).toThrow(/isn't available on the deployed contracts/i);
  });

  it("pickBuyEntrypoint selects buy_v2 when available and buy otherwise", () => {
    expect(pickBuyEntrypoint({ has: (c) => c === "marketCore.buyV2" })).toBe("buy_v2");
    expect(pickBuyEntrypoint({ has: () => false })).toBe("buy");
  });
});
