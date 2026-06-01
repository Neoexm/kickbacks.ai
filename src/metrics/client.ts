import { randomUUID } from "node:crypto";
import { type AdSurface } from "../types/surface";

export type { AdSurface };

type Fetch = typeof fetch;
// W3 viewership: `view_tick` is a 5s heartbeat fired while an ad accumulates
// visible time; `view_threshold_met` fires exactly once per ad-surface-
// session when cumulative visible time crosses the configured threshold
// (default 15s, server-overridable via portfolio.view_threshold_seconds).
// `error_impression` is the MAX_SESSION_MS safety-net fire (default 5 s) —
// once per session if the natural session-close never lands so a stuck ad
// still bills. Credits now key off `view_threshold_met` + `error_impression`;
// `impression_viewable` is kept for analytics-only.
export type MetricEvent =
  | "impression_rendered"
  | "impression_viewable"
  | "prompt_view"
  | "click"
  | "view_tick"
  | "view_threshold_met"
  | "error_impression";

const EVENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newMetricEventUuid(): string {
  return randomUUID();
}

/** POSTs the S2 /v1/metrics contract (required keys
 *  event_type,ad_id,campaign_id,client_id,ts,nonce; server-authoritative on
 *  tier/measurement). Best-effort: never throws. */
export class MetricsClient {
  constructor(private base: string, private token: () => string | null,
              private clientId: () => string, private extVersion: string,
              private f: Fetch = fetch) {}

  async send(event: MetricEvent,
             a: { adId: string; campaignId: string; ccVersion: string;
                  corr?: string; surface?: AdSurface; visibleMs?: number;
                  sessionNonce?: string; viewable?: boolean;
                  viewPct?: number; viewMs?: number;
                  sessionToken?: string; eventUuid?: string }): Promise<void> {
    try {
      const eventUuid = a.eventUuid && EVENT_UUID_RE.test(a.eventUuid)
        ? a.eventUuid
        : newMetricEventUuid();
      const body: Record<string, unknown> = {
        event_type: event, ad_id: a.adId, campaign_id: a.campaignId,
        client_id: this.clientId(), ts: new Date().toISOString(),
        claude_code_version: a.ccVersion, extension_version: this.extVersion,
        nonce: eventUuid,
      };
      // W3 viewership additions — only included when present so we don't
      // pollute legacy event shapes (impression_*, click) with empty fields.
      if (a.surface) body.surface = a.surface;
      if (typeof a.visibleMs === "number") body.visible_ms = a.visibleMs;
      if (a.sessionNonce) body.session_nonce = a.sessionNonce;
      if (typeof a.viewable === "boolean") body.viewable = a.viewable;
      if (typeof a.viewPct === "number") body.view_pct = a.viewPct;
      if (typeof a.viewMs === "number") body.view_ms = a.viewMs;
      if (a.sessionToken) body.session_token = a.sessionToken;
      const t = this.token();
      await this.f(`${this.base}/v1/metrics`, {
        method: "POST",
        headers: { "content-type": "application/json",
          ...(t ? { authorization: `Bearer ${t}` } : {}),
          // W1 rename: send the new header AND the legacy one for one release
          // so the backend dual-accept can be staged independently.
          ...(a.corr ? { "X-Kickbacks-Corr": a.corr, "X-Vibe-Corr": a.corr } : {}) },
        body: JSON.stringify(body),
      });
    } catch { /* metrics are best-effort */ }
  }
}
