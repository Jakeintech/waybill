import { homedir } from "node:os";
import { join } from "node:path";

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["WAYBILL_HOME"];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  return join(homedir(), ".waybill");
}
