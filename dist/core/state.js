import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const stateFile = resolve(process.cwd(), "data", "state.json");
export function readState() {
    if (!existsSync(stateFile))
        return {};
    try {
        return JSON.parse(readFileSync(stateFile, "utf-8"));
    }
    catch {
        return {};
    }
}
export function writeState(s) {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(s, null, 2));
}
/** Update a single top-level key. Reads, patches, writes atomically. */
export function updateState(key, value) {
    const s = readState();
    s[key] = value;
    writeState(s);
}
//# sourceMappingURL=state.js.map