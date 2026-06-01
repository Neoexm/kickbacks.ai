import type * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { Loopback } from "../loopback";
import { resolveLoopbackBase } from "../loopback";

const STABLE_TOKEN_KEY = "kickbacks.loopback.token";
const STABLE_PORT_KEY = "kickbacks.loopback.port";

export interface LoopbackBootResult { port: number; token: string; base: string; }

export async function bootLoopback(lb: Loopback, ctx: vscode.ExtensionContext): Promise<LoopbackBootResult> {
  let stableToken = ctx.globalState.get<string>(STABLE_TOKEN_KEY) || "";
  if (!/^[0-9a-f]{16,}$/i.test(stableToken)) {
    stableToken = randomBytes(16).toString("hex");
    void ctx.globalState.update(STABLE_TOKEN_KEY, stableToken);
  }
  const stablePort = Number(ctx.globalState.get<number>(STABLE_PORT_KEY) || 0) || undefined;
  const { port, token } = await lb.start({ token: stableToken, preferredPort: stablePort, preferredPortRange: 4 });
  if (port > 0 && port !== stablePort) void ctx.globalState.update(STABLE_PORT_KEY, port);
  const base = port < 0 ? "" : await resolveLoopbackBase(port, token);
  return { port, token, base };
}
