/** SMART MONEY TRACKER entry point: see src/smart-money/cli/main.ts. */
import { main } from "../src/smart-money/cli/main.ts";

process.exitCode = await main(process.argv.slice(2));
