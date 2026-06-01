type Fetch = typeof fetch;
export interface KillState {
  killed: boolean;
  scope?: string;
  reason?: string;
  /** wave-2A-F06: distinguishes a fail-safe "treated as killed because
   *  unreachable" from a real backend killed: true response. Callers can
   *  render an "offline" status (status bar already has the `kind:"offline"`
   *  variant unused pre-fix) instead of the alarming "killed" badge that
   *  used to flicker on every brief network blip. The patch/restore
   *  behavior is unchanged -- offline still implies killed for the purposes
   *  of "is it safe to serve an ad" (fail-safe posture). */
  offline?: boolean;
}

/** Polls GET /v1/killswitch. Fail-safe: any error => killed (matches the S2
 *  resolve_killed posture — never serve under a kill). When the error was
 *  unreachability rather than a real backend kill, `offline: true` is set
 *  so the status bar can render distinct UX without losing the kill posture. */
export class KillSwitchClient {
  constructor(private base: string, private f: Fetch = fetch) {}

  async checkOnce(ccVersion: string, campaignId: string): Promise<KillState> {
    try {
      const r = await this.f(
        `${this.base}/v1/killswitch?version=${encodeURIComponent(ccVersion)}` +
        `&campaign=${encodeURIComponent(campaignId)}`);
      if (!r.ok) {
        // 5xx or 4xx -> offline-equivalent (backend reachable but not
        // returning the contract). Still fail-safe killed.
        return { killed: true, offline: true, reason: `status ${r.status}` };
      }
      const j = await r.json() as KillState;
      return {
        killed: !!j.killed,
        scope: j.scope,
        reason: j.reason,
        offline: false,
      };
    } catch (e) {
      // Network/DNS error -> truly offline. Caller renders "offline"; kill
      // posture preserved.
      return { killed: true, offline: true, reason: `fail-safe: ${String(e)}` };
    }
  }
}
