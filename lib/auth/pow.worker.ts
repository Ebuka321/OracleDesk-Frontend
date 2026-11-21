import { solveSteps } from "./pow";

export type PowWorkerInMessage =
  | {
      type: "solve";
      id: string;
      account: string;
      salt: string;
      bits: number;
      startNonce?: string;
    }
  | {
      type: "cancel";
      id: string;
    };

export type PowWorkerOutMessage =
  | {
      type: "progress";
      id: string;
      tried: number;
    }
  | {
      type: "solved";
      id: string;
      nonce: string;
    };

let activeId: string | null = null;
let activeController: AbortController | null = null;

self.onmessage = (e: MessageEvent<PowWorkerInMessage>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    if (activeId === msg.id) {
      activeController?.abort();
      activeId = null;
      activeController = null;
    }
    return;
  }

  if (msg.type === "solve") {
    activeController?.abort();
    const id = msg.id;
    activeId = id;
    const controller = new AbortController();
    activeController = controller;

    const startNonce = msg.startNonce ? BigInt(msg.startNonce) : undefined;
    const generator = solveSteps({
      account: msg.account,
      salt: msg.salt,
      bits: msg.bits,
      startNonce,
      batch: 1000,
      signal: controller.signal,
    });

    let lastProgressTime = performance.now();

    function step() {
      if (activeId !== id || controller.signal.aborted) return;
      const res = generator.next();
      if (res.done) return;

      const value = res.value;
      if ("nonce" in value) {
        self.postMessage({ type: "solved", id, nonce: value.nonce } satisfies PowWorkerOutMessage);
        activeId = null;
        activeController = null;
        return;
      }

      const now = performance.now();
      if (now - lastProgressTime >= 50) {
        lastProgressTime = now;
        self.postMessage({ type: "progress", id, tried: value.tried } satisfies PowWorkerOutMessage);
      }

      // Schedule next slice without blocking event loop
      setTimeout(step, 0);
    }

    step();
  }
};
