export interface PatchAd {
  adId: string; campaignId: string; seat: string; adText: string;
  iconRef: string; iconUrl: string; clickUrl: string; bannerEnabled: boolean;
  sessionToken: string;
}

export interface PortfolioBalances {
  lifetimeUsd: string;
  todayUsd: string;
  lastUpdatedMs: number;
}

export interface PortfolioResponse {
  ad: PatchAd | null;
  ads: PatchAd[];
  queueId: string;
  ttlMs: number;
  rotationIntervalMs: number;
  viewThresholdMs: number;
  balances: PortfolioBalances | null;
}

type Fetch = typeof fetch;

const DEFAULT_VIEW_THRESHOLD_MS = 3_000;

/** Consumes S2's /v1/portfolio shape. W4-extended fields are optional so an
 *  older backend still works: queue_id, view_threshold_seconds, balances. */
export class PortfolioClient {
  private cache: { resp: PortfolioResponse; expiresAt: number } | null = null;
  constructor(private base: string, private token: () => string | null,
              private f: Fetch = fetch) {}

  async fetchAd(ccVersion: string): Promise<PatchAd | null> {
    const r = await this.fetchPortfolio(ccVersion);
    return r?.ad ?? null;
  }

  /** W4 queue-aware fetch. Returns the full response so callers can manage
   *  a local queue (drain to depth N, then refetch) and surface the server-
   *  authoritative balances + view threshold. */
  async fetchPortfolio(ccVersion: string): Promise<PortfolioResponse | null> {
    try {
      const r = await this.f(
        `${this.base}/v1/portfolio?claude_code_version=${encodeURIComponent(ccVersion)}`,
        { headers: this.authHeaders() });
      if (!r.ok) throw new Error(`portfolio ${r.status}`);
      const body = await r.json() as {
        ttl_seconds: number;
        view_threshold_seconds?: number;
        rotation_interval_seconds?: number;
        queue_id?: string;
        balances?: { lifetime_usd?: string; today_usd?: string;
                     last_updated_ms?: number };
        ads: { ad_id: string; campaign_id: string; seat?: string; title_text: string;
               icon_ref: string; icon_url?: string; click_url: string;
               banner_enabled?: boolean; session_token?: string }[];
      };
      const ads: PatchAd[] = (body.ads || []).map((a) => ({
        adId: a.ad_id, campaignId: a.campaign_id, seat: a.seat || "",
        adText: a.title_text,
        iconRef: a.icon_ref, iconUrl: a.icon_url || "", clickUrl: a.click_url,
        bannerEnabled: a.banner_enabled === true,
        sessionToken: a.session_token || "",
      }));
      const balances: PortfolioBalances | null = body.balances
        && typeof body.balances.lifetime_usd === "string"
        && typeof body.balances.today_usd === "string"
        ? { lifetimeUsd: body.balances.lifetime_usd,
            todayUsd: body.balances.today_usd,
            lastUpdatedMs: body.balances.last_updated_ms ?? Date.now() }
        : null;
      const rotationSec = body.rotation_interval_seconds;
      const resp: PortfolioResponse = {
        ad: ads[0] ?? null,
        ads,
        queueId: body.queue_id || "",
        ttlMs: (body.ttl_seconds || 0) * 1000,
        rotationIntervalMs: rotationSec ? rotationSec * 1000 : 120_000,
        viewThresholdMs: (body.view_threshold_seconds
          ? body.view_threshold_seconds * 1000
          : DEFAULT_VIEW_THRESHOLD_MS),
        balances,
      };
      this.cache = { resp, expiresAt: Date.now() + resp.ttlMs };
      return resp;
    } catch {
      if (this.cache && Date.now() < this.cache.expiresAt) return this.cache.resp;
      return null;
    }
  }

  private authHeaders(): Record<string, string> {
    const t = this.token();
    return t ? { authorization: `Bearer ${t}` } : {};
  }
}
