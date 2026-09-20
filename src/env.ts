import fs from "node:fs";

export const env = process.env;

export function debugLog(text: string) {
  if (env.PLANNER_DEBUG) fs.appendFileSync(env.PLANNER_DEBUG, text);
}
