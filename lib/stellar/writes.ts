import type { Signer, OutcomeTag } from "./clients";
import { marketCore as defaultMarketCore, token as defaultToken, Outcomes } from "./clients";
import { read } from "./typed-call";
import { send } from "./tx";
import { minOut, maxIn } from "./units";
import { solveSellForShares } from "./sell-solver";
import { UserFacingError } from "./errors";

export interface WriteDeps {
  clients?: {
    marketCore: typeof defaultMarketCore;
    token: typeof defaultToken;
  };
}

export interface BuyParams {
  marketId: bigint | string;
  outcome: OutcomeTag;
  collateralIn: bigint;
  slippageBps?: number;
  minSharesOut?: bigint;
  onSigned?: (hash: string) => void;
  review?: unknown;
}

export interface BuyResult {
  sharesOut: bigint;
  quotedShares: bigint;
  minSharesOut: bigint;
  txHash: string;
  ledger: number | null;
  collateralIn: bigint;
  holder: string;
}

export interface SellParams {
  marketId: bigint | string;
  outcome: OutcomeTag;
  shares: bigint;
  mode?: "all" | "shares";
  slippageBps?: number;
  review?: unknown;
}

export interface SellResult {
  sharesSold: bigint;
  collateralOut: bigint;
  maxSharesIn: bigint;
  txHash: string;
  ledger: number | null;
  holder: string;
}

export interface RedeemParams {
  marketId: bigint | string;
  review?: unknown;
}

export interface RedeemResult {
  payout: bigint;
  txHash: string;
  ledger: number | null;
  holder: string;
}

export interface UsdcTransferParams {
  to: string;
  amount: bigint;
  followUp?: unknown;
  review?: unknown;
}

export interface UsdcTransferResult {
  txHash: string;
  holder: string;
}

function toId(id: bigint | string | number): bigint {
  return BigInt(id);
}

export async function executeBuy(signer: Signer, p: BuyParams, deps?: WriteDeps): Promise<BuyResult> {
  const marketCore = deps?.clients?.marketCore ?? defaultMarketCore;
  const client = marketCore(signer);
  const id = toId(p.marketId);
  const outcomeObj = Outcomes[p.outcome];

  let quotedShares: bigint;
  let minSharesOut: bigint;

  if (p.minSharesOut !== undefined) {
    quotedShares = p.minSharesOut;
    minSharesOut = p.minSharesOut;
  } else {
    const quoteTx = await client.quote_buy({
      market_id: id,
      outcome: outcomeObj,
      collateral_in: p.collateralIn,
    });
    quotedShares = read(quoteTx);
    const slippage = p.slippageBps ?? 100;
    minSharesOut = minOut(quotedShares, slippage);
  }

  const buyTx = await client.buy({
    market_id: id,
    outcome: outcomeObj,
    collateral_in: p.collateralIn,
    min_shares_out: minSharesOut,
    trader: signer.publicKey,
  });

  const { value, txHash, ledger } = await send(buyTx, "marketCore");
  if (txHash && p.onSigned) {
    p.onSigned(txHash);
  }

  return {
    sharesOut: value,
    quotedShares,
    minSharesOut,
    txHash: txHash ?? "",
    ledger,
    collateralIn: p.collateralIn,
    holder: signer.publicKey,
  };
}

export async function executeSell(signer: Signer, p: SellParams, deps?: WriteDeps): Promise<SellResult> {
  const marketCore = deps?.clients?.marketCore ?? defaultMarketCore;
  const client = marketCore(signer);
  const id = toId(p.marketId);

  const marketTx = await client.get_market({ market_id: id });
  const market = read(marketTx);

  const posTx = await client.get_position({ market_id: id, holder: signer.publicKey });
  const position = read(posTx);

  const heldShares = p.outcome === "Yes" ? position.yes : position.no;
  const shares = p.mode === "all" ? heldShares : p.shares;

  if (shares <= 0n) {
    throw new UserFacingError({
      kind: "contract",
      code: "InvalidAmount",
      errorCode: "contract.marketCore.InvalidAmount",
      message: "Enter a share amount greater than zero.",
    });
  }
  if (shares > heldShares) {
    throw new UserFacingError({
      kind: "contract",
      code: "InsufficientShares",
      errorCode: "contract.marketCore.InsufficientShares",
      message: "You don't have enough shares for this sale.",
    });
  }

  const [rSold, rOther] = p.outcome === "Yes" ? [market.reserve_yes, market.reserve_no] : [market.reserve_no, market.reserve_yes];
  const feeBps = BigInt(market.fee_bps);

  const local = solveSellForShares(rSold, rOther, shares, feeBps);
  if ("error" in local) {
    throw new UserFacingError({
      kind: "contract",
      code: local.error === "too-small" ? "InvalidAmount" : "InsufficientLiquidity",
      errorCode: local.error === "too-small" ? "contract.marketCore.InvalidAmount" : "contract.marketCore.InsufficientLiquidity",
      message: local.error === "too-small"
        ? "That's too few shares to sell after fees."
        : "There isn't enough liquidity to sell that many shares.",
    });
  }

  const slippageBps = p.slippageBps ?? 100;
  const maxSharesIn = [maxIn(shares, slippageBps) + 1n, heldShares].reduce((a, b) => (a < b ? a : b));

  const sellTx = await client.sell({
    trader: signer.publicKey,
    market_id: id,
    outcome: Outcomes[p.outcome],
    collateral_out: local.collateralOut,
    max_shares_in: maxSharesIn,
  });

  const { value, txHash, ledger } = await send(sellTx, "marketCore");

  return {
    sharesSold: value,
    collateralOut: local.collateralOut,
    maxSharesIn,
    txHash: txHash ?? "",
    ledger,
    holder: signer.publicKey,
  };
}

export async function executeRedeem(signer: Signer, p: RedeemParams, deps?: WriteDeps): Promise<RedeemResult> {
  const marketCore = deps?.clients?.marketCore ?? defaultMarketCore;
  const client = marketCore(signer);
  const id = toId(p.marketId);

  const redeemTx = await client.redeem({
    holder: signer.publicKey,
    market_id: id,
  });

  const { value, txHash, ledger } = await send(redeemTx, "marketCore");

  return {
    payout: value,
    txHash: txHash ?? "",
    ledger,
    holder: signer.publicKey,
  };
}

export async function executeUsdcTransfer(
  signer: Signer,
  p: UsdcTransferParams,
  deps?: WriteDeps,
): Promise<UsdcTransferResult> {
  if (p.amount <= 0n) {
    throw new UserFacingError({
      kind: "contract",
      code: "InvalidAmount",
      errorCode: "contract.marketCore.InvalidAmount",
      message: "Enter an amount greater than zero.",
    });
  }

  const token = deps?.clients?.token ?? defaultToken;
  const tx = await token.transfer({ from: signer.publicKey, to: p.to, amount: p.amount }, signer);
  const { txHash } = await send(tx, "marketCore");

  if (!txHash) {
    throw new UserFacingError({
      kind: "unknown",
      errorCode: "kind.unknown",
      message: "The payment was sent but no transaction hash came back.",
    });
  }

  return {
    txHash,
    holder: signer.publicKey,
  };
}
