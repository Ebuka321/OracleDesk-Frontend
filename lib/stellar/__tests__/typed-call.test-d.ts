// Compile-time pins for generated contract entrypoints used by app code.
// The usage checker requires a pin for every binding method it finds.
import { expectTypeOf } from "vitest";
import type { Value, MC, TC, RC, RR } from "../typed-call";

expectTypeOf<Value<MC, "claim_pool_remainder">>().not.toBeAny();
expectTypeOf<Value<MC, "quote_sell">>().not.toBeAny();
expectTypeOf<Value<TC, "get_config">>().not.toBeAny();
expectTypeOf<Value<TC, "daily_usage">>().not.toBeAny();
expectTypeOf<Value<TC, "available_capital">>().not.toBeAny();
expectTypeOf<Value<RR, "trace_count">>().not.toBeAny();
