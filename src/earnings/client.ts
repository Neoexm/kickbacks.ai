type Fetch = typeof fetch;

export interface Earnings { lifetimeUsd: string; todayUsd: string; }

/** Optional auth-recovery callback. When the first GET /v1/earnings
 *  returns 401, the client calls this to refresh the access token, then
 *  retries the request exactly once with the new bearer. Without this,
 *  a transient 401 (token rotated mid-poll) leaves the status bar's
 *  `lastUsd`/`lastToday` stale OR blank on the very first poll. */
export type EarningsAuthRecovery = () => Promise<boolean>;

/** GET /v1/earnings — the user's display-only 50/50 credit (today + lifetime),
 *  for the status bar. Fail-safe: any error / signed-out => null; the status
 *  bar then renders $0.00 (it never shows a bare label and never throws). */
export class EarningsClient {
  constructor(private base: string, private token: () => string | null,
              private f: Fetch = fetch,
              private onAuth401: EarningsAuthRecovery | null = null) {}

  async fetch(): Promise<Earnings | null> {
    try {
      const first = await this.fetchOnce();
      if (first.outcome === "ok") return first.earnings;
      // 401 path: refresh once + retry. Any other failure (network,
      // 5xx, malformed body) returns null without retry — fail-fast on
      // structural problems so the caller's `lastUsd` cache holds.
      if (first.outcome === "401" && this.onAuth401) {
        const refreshed = await this.onAuth401();
        if (refreshed) {
          const second = await this.fetchOnce();
          if (second.outcome === "ok") return second.earnings;
        }
      }
      return null;
    } catch { return null; }
  }

  private async fetchOnce(): Promise<
    { outcome: "ok"; earnings: Earnings }
    | { outcome: "401" | "error" }
  > {
    try {
      const t = this.token();
      if (!t) return { outcome: "error" };
      const r = await this.f(`${this.base}/v1/earnings`,
        { headers: { authorization: `Bearer ${t}` } });
      if (r.status === 401) return { outcome: "401" };
      if (!r.ok) return { outcome: "error" };
      const j = await r.json() as { lifetime_usd?: string; today_usd?: string };
      if (typeof j.lifetime_usd !== "string" || typeof j.today_usd !== "string")
        return { outcome: "error" };
      return { outcome: "ok",
        earnings: { lifetimeUsd: j.lifetime_usd, todayUsd: j.today_usd } };
    } catch { return { outcome: "error" }; }
  }
}
