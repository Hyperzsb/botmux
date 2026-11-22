/**
 * Mid-turn renewal of locally minted bytedcli identities.
 *
 * A turn's identity is minted once when the turn is prepared, but a ByteCloud
 * JWT lives ~2 hours. A long job launched by one turn (a nightly batch, a
 * backfill) would otherwise start failing with 401 halfway through. The daemon
 * re-publishes the SAME person's identity for the SAME turn with fresh tokens
 * before they expire; it never changes whose identity a turn carries.
 *
 * Only identities minted from this machine's per-person bytedcli HOME are
 * tracked (platform grants have their own lifetime). An entry is dropped as
 * soon as the turn's published material is gone or was replaced by anything
 * other than what this module last wrote.
 */
import { logger } from '../utils/logger.js';
import { renewBytedcliJwts } from '../services/bytedcli-auth.js';
import { BYTECLOUD_USER_SITES, type ByteCloudUserSite } from '../utils/bytecloud-sites.js';
import {
  recallProvenIdentityContent,
  renderIdentityEnv,
  publishedIdentityShape,
  writeSessionIdentity,
  type BytedCliIdentity,
  type LarkdevIdentity,
  type BytedcliRegion,
} from './cli-identity.js';
import { activeIdentityTurns } from './active-identity-turns.js';

/** Renew once the soonest-expiring ByteCloud JWT has less than this left. */
export const BYTEDCLI_RENEW_BEFORE_EXPIRY_MS = 40 * 60_000;
/** How often the daemon sweeps tracked turns. */
export const BYTEDCLI_RENEWAL_SWEEP_MS = 5 * 60_000;

type RenewableIdentity = (BytedCliIdentity | LarkdevIdentity) & { turnId: string };

export interface RenewalEntry {
  sessionDataDir: string;
  sessionId: string;
  credentialOpenId: string;
  identity: RenewableIdentity;
  failedSites?: Map<ByteCloudUserSite, { attempts: number; nextRetryAt: number }>;
}

const entries = new Map<string, RenewalEntry>();

function entryKey(sessionDataDir: string, sessionId: string, turnId: string, tool: RenewableIdentity['tool']): string {
  return JSON.stringify([sessionDataDir, sessionId, turnId, tool]);
}

function jwtExpiryMs(jwt: string | undefined): number | undefined {
  if (!jwt) return undefined;
  try {
    const exp = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'))?.exp;
    return typeof exp === 'number' ? exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
}

/** Soonest expiry among the ByteCloud JWTs a wrapper may select. */
export function bytedcliIdentityExpiryMs(identity: BytedCliIdentity | LarkdevIdentity): number | undefined {
  const expiries = [
    ...('cloudJwt' in identity ? [identity.cloudJwt] : []),
    ...Object.values(identity.cloudJwts ?? {}),
    ...('regionalCloudJwts' in identity ? Object.values(identity.regionalCloudJwts ?? {}) : []),
  ]
    .map(jwtExpiryMs)
    .filter((v): v is number => v !== undefined);
  return expiries.length ? Math.min(...expiries) : undefined;
}

/** Track a proven bytedcli identity just published from a local mint. */
export function trackBytedcliIdentityRenewal(entry: RenewalEntry): void {
  // Registered jobs have their own per-invocation authority/lease checks. The
  // ordinary-turn timer must never renew their cache or derive its HOME after
  // the job has been retired in the authority store.
  if (entry.identity.turnId.startsWith('background:')) return;
  entries.set(entryKey(entry.sessionDataDir, entry.sessionId, entry.identity.turnId, entry.identity.tool), {
    ...entry,
    identity: { ...entry.identity },
    failedSites: new Map(entry.failedSites ?? []),
  });
}

/** Stop every locally-minted renewable tool for this exact terminal turn. */
export function untrackBytedcliIdentityRenewal(
  sessionDataDir: string,
  sessionId: string,
  turnId: string,
): void {
  for (const [key, entry] of entries) {
    if (entry.sessionDataDir === sessionDataDir && entry.sessionId === sessionId
      && entry.identity.turnId === turnId) entries.delete(key);
  }
}

/** Drop all renewal state when a session is closed or leaves proven mode. */
export function untrackSessionBytedcliIdentityRenewals(
  sessionDataDir: string,
  sessionId: string,
): void {
  for (const [key, entry] of entries) {
    if (entry.sessionDataDir === sessionDataDir && entry.sessionId === sessionId) entries.delete(key);
  }
}

/** Test/diagnostic hook. */
export function trackedBytedcliRenewalCount(): number {
  return entries.size;
}

export function forgetBytedcliIdentityRenewals(): void {
  entries.clear();
}

async function renewPublishedIdentity(
  entry: RenewalEntry,
  nowMs: number,
): Promise<Pick<BytedCliIdentity, 'cloudJwt' | 'cloudJwts' | 'codeJwt' | 'regionalCloudJwts'> | null> {
  const siteEntries = BYTECLOUD_USER_SITES.filter(site => entry.identity.cloudJwts?.[site]);
  if (!siteEntries.length) {
    const jwts = await renewBytedcliJwts(entry.credentialOpenId);
    return jwts ? {
      cloudJwt: jwts.cloudJwt,
      ...(jwts.codeJwt ? { codeJwt: jwts.codeJwt } : {}),
      ...(jwts.regionalCloudJwts ? { regionalCloudJwts: jwts.regionalCloudJwts } : {}),
    } : null;
  }

  const cloudJwts: Partial<Record<ByteCloudUserSite, string>> = {};
  const regionalCloudJwts: Partial<Record<BytedcliRegion, string>> = {};
  let codeJwt: string | undefined;
  for (const site of siteEntries) {
    const failed = entry.failedSites?.get(site);
    if (failed && failed.nextRetryAt > nowMs) continue;
    try {
      const jwts = await renewBytedcliJwts(entry.credentialOpenId, site);
      if (!jwts) throw new Error('provider returned no renewable credential');
      cloudJwts[site] = jwts.cloudJwt;
      codeJwt ??= jwts.codeJwt;
      Object.assign(regionalCloudJwts, jwts.regionalCloudJwts);
      entry.failedSites?.delete(site);
    } catch (error) {
      const attempts = (failed?.attempts ?? 0) + 1;
      const delay = attempts === 1 ? 5 * 60_000 : attempts === 2 ? 15 * 60_000 : 30 * 60_000;
      entry.failedSites ??= new Map();
      entry.failedSites.set(site, { attempts, nextRetryAt: nowMs + delay });
      logger.debug(`[bytedcli-renewal] could not renew optional site ${site}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return Object.keys(cloudJwts).length ? {
    cloudJwts,
    ...(codeJwt ? { codeJwt } : {}),
    ...(Object.keys(regionalCloudJwts).length ? { regionalCloudJwts } : {}),
  } : null;
}

function stillPublished(entry: RenewalEntry): boolean {
  const active = activeIdentityTurns(entry.sessionDataDir, entry.sessionId);
  if (active !== null && !active.includes(entry.identity.turnId)) return false;
  const current = recallProvenIdentityContent(
    entry.sessionDataDir,
    entry.sessionId,
    entry.identity.turnId,
    entry.identity.tool,
  );
  return current !== undefined && current === renderIdentityEnv(publishedIdentityShape(entry.sessionDataDir, entry.sessionId, entry.identity));
}

function renewalDue(entry: RenewalEntry, nowMs: number, renewBeforeMs: number): boolean {
  const siteEntries = BYTECLOUD_USER_SITES.filter(site => entry.identity.cloudJwts?.[site]);
  if (!siteEntries.length) {
    const expiresAt = bytedcliIdentityExpiryMs(entry.identity);
    return expiresAt !== undefined && expiresAt - nowMs <= renewBeforeMs;
  }
  const eligible = siteEntries.filter(site => {
    const failed = entry.failedSites?.get(site);
    return !failed || failed.nextRetryAt <= nowMs;
  });
  const hasSiteInBackoff = siteEntries.some(site => {
    const failed = entry.failedSites?.get(site);
    return failed !== undefined && failed.nextRetryAt > nowMs;
  });
  if (eligible.some(site => (entry.failedSites?.get(site)?.nextRetryAt ?? Infinity) <= nowMs)) return true;
  if (eligible.some(site => {
    const expiresAt = jwtExpiryMs(entry.identity.cloudJwts?.[site]);
    return expiresAt !== undefined && expiresAt - nowMs <= renewBeforeMs;
  })) return true;
  // Regional tokens are returned opportunistically by a site renewal but do
  // not carry site provenance themselves. If any site that could replace an
  // expired regional token is in backoff, let that site's retry deadline drive
  // the next attempt. Otherwise the stale regional token would renew every
  // healthy site on every sweep while the failed site is deliberately skipped.
  if ('regionalCloudJwts' in entry.identity && eligible.length && !hasSiteInBackoff) {
    return Object.values(entry.identity.regionalCloudJwts ?? {}).some(jwt => {
      const expiresAt = jwtExpiryMs(jwt);
      return expiresAt !== undefined && expiresAt - nowMs <= renewBeforeMs;
    });
  }
  return false;
}

const inFlight = new Set<string>();

/**
 * Renew every tracked identity close to expiry. Never throws; a failed renewal
 * keeps the current (still valid) tokens and is retried on the next sweep.
 */
export async function renewExpiringBytedcliIdentities(
  now: () => number = Date.now,
  renewBeforeMs: number = BYTEDCLI_RENEW_BEFORE_EXPIRY_MS,
): Promise<number> {
  let renewed = 0;
  for (const [key, entry] of [...entries]) {
    if (entries.get(key) !== entry) continue;
    if (inFlight.has(key)) continue;
    if (!stillPublished(entry)) { entries.delete(key); continue; }
    const nowMs = now();
    if (!renewalDue(entry, nowMs, renewBeforeMs)) continue;
    inFlight.add(key);
    try {
      const jwts = await renewPublishedIdentity(entry, nowMs);
      if (!jwts) {
        logger.warn(`[bytedcli-renewal] could not renew ${entry.sessionId.slice(0, 8)}/${entry.identity.turnId.slice(0, 12)}; keeping current tokens`);
        continue;
      }
      // The turn may have ended or been republished while the CLI ran.
      if (entries.get(key) !== entry) continue;
      if (!stillPublished(entry)) { entries.delete(key); continue; }
      const identity: RenewableIdentity = entry.identity.tool === 'larkdev'
        ? {
            tool: 'larkdev',
            cloudJwts: { ...entry.identity.cloudJwts, ...jwts.cloudJwts },
            turnId: entry.identity.turnId,
            ...(entry.identity.openId ? { openId: entry.identity.openId } : {}),
          }
        : {
            tool: 'bytedcli',
            ...(jwts.cloudJwt ?? entry.identity.cloudJwt ? { cloudJwt: jwts.cloudJwt ?? entry.identity.cloudJwt } : {}),
            ...(jwts.cloudJwts || entry.identity.cloudJwts
              ? { cloudJwts: { ...entry.identity.cloudJwts, ...jwts.cloudJwts } }
              : {}),
            // Keep material the renewal could not refresh rather than drop it.
            ...(jwts.codeJwt ?? entry.identity.codeJwt ? { codeJwt: jwts.codeJwt ?? entry.identity.codeJwt } : {}),
            ...(jwts.regionalCloudJwts || entry.identity.regionalCloudJwts
              ? { regionalCloudJwts: { ...entry.identity.regionalCloudJwts, ...jwts.regionalCloudJwts } }
              : {}),
            turnId: entry.identity.turnId,
            ...(entry.identity.openId ? { openId: entry.identity.openId } : {}),
          };
      writeSessionIdentity(entry.sessionDataDir, entry.sessionId, identity, 'proven');
      entries.set(key, { ...entry, identity });
      renewed += 1;
      const next = bytedcliIdentityExpiryMs(identity);
      logger.info(`[bytedcli-renewal] renewed ${entry.sessionId.slice(0, 8)}/${entry.identity.turnId.slice(0, 12)}`
        + (next ? ` until ${new Date(next).toISOString()}` : ''));
    } catch (error) {
      logger.warn(`[bytedcli-renewal] renewal failed for ${entry.sessionId.slice(0, 8)}: `
        + `${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(key);
    }
  }
  return renewed;
}
