// Every test process (and the servers it spawns) keeps checked-job records in its own temporary state directory,
// never the user's real one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-state-"));
process.env.BAMBU_STATE_DIR = dir;
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
