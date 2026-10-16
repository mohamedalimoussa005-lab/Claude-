/** SMART MONEY TRACKER entry point: see src/smart-money/cli/main.ts. The network factory is injected from here. */
import { main } from "../src/smart-money/cli/main.ts";
import { createLiveService } from "./smart-money-live.ts";

process.exitCode = await main(process.argv.slice(2), process.env, console.log, { createLiveService });
