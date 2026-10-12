import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const stateFile = resolve(process.cwd(), "data", "state.json");

type State = Record<string, unknown>;

export function readState(): State {
  if (!existsSync(stateFile)) return {};
  try {
    return JSON.parse(readFileSync(stateFile, "utf-8")) as State;
  } catch {
    return {};
  }
}

export function writeState(s: State): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(s, null, 2));
}

/** Update a single top-level key. Reads, patches, writes atomically. */
export function updateState(key: string, value: unknown): void {
  const s = readState();
  s[key] = value;
  writeState(s);
}
