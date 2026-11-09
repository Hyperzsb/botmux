/**
 * ByteCloud credential partitions governed by trigger-user authentication.
 *
 * These are credential sites, not every spelling accepted by bytedcli.  The
 * CLI currently aliases BOE to CN, i18n to i18n-bd, the US BDEE/USTS profiles
 * to us-ttp, and the EU limited/full profiles to eu-ttp.  Keep the allowlist in
 * one module so minting and wrapper publication cannot acquire different site
 * sets.  Unknown future sites are deliberately not minted; the wrapper's
 * prefix-based credential scrub then makes them fail closed.
 */
export const BYTECLOUD_USER_JWT_ENV_BY_SITE = {
  cn: 'BYTECLOUD_CLI_API_JWT_TOKEN_CN',
  'i18n-tt': 'BYTECLOUD_CLI_API_JWT_TOKEN_I18N_TT',
  'i18n-bd': 'BYTECLOUD_CLI_API_JWT_TOKEN_I18N_BD',
  'eu-ttp': 'BYTECLOUD_CLI_API_JWT_TOKEN_EU_TTP',
  'us-ttp': 'BYTECLOUD_CLI_API_JWT_TOKEN_US_TTP',
} as const;

export type ByteCloudUserSite = keyof typeof BYTECLOUD_USER_JWT_ENV_BY_SITE;

export const BYTECLOUD_USER_SITES = Object.freeze(
  Object.keys(BYTECLOUD_USER_JWT_ENV_BY_SITE) as ByteCloudUserSite[],
);

/**
 * Every public spelling accepted by bytedcli that maps to one credential
 * partition. Login/status commands preserve the selected control plane by
 * normalizing aliases here instead of silently falling back to CN.
 */
export const BYTECLOUD_USER_SITE_ALIASES: Readonly<Record<string, ByteCloudUserSite>> = Object.freeze({
  cn: 'cn',
  boe: 'cn',
  i18n: 'i18n-bd',
  'i18n-bd': 'i18n-bd',
  'i18n-tt': 'i18n-tt',
  'eu-ttp': 'eu-ttp',
  'eu-ttp-limited': 'eu-ttp',
  'eu-ttp-full': 'eu-ttp',
  'us-ttp': 'us-ttp',
  'us-ttp-bdee': 'us-ttp',
  'us-ttp-usts': 'us-ttp',
});

export function normalizeByteCloudUserSite(value: string | undefined): ByteCloudUserSite | null {
  if (!value) return null;
  return BYTECLOUD_USER_SITE_ALIASES[value.trim().toLowerCase()] ?? null;
}

export const BYTECLOUD_USER_SITE_USAGE = BYTECLOUD_USER_SITES.join('|');
