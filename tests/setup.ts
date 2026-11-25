import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VICBOT_HOME = mkdtempSync(join(tmpdir(), "vicbot-test-"));
process.env.VICBOT_HARNESSES = "null";
process.env.VICBOT_NULL_DELAY_MS = "5";
process.env.VICBOT_CONCURRENCY = "4";
