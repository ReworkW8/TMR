import * as crypto from 'node:crypto';

/** MD5 hex digest – used because TMU clients send MD5(password) */
export function md5(input: string): string {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

/** Generate a cryptographically random session token */
export function generateToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** Generate a random server ID */
export function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Normalise a password for storage/comparison.
 * TMU clients send MD5(password) already. If the input looks like a 32-char hex
 * MD5 digest we store it as-is; otherwise we MD5 it ourselves.
 * This lets both the game AND a manual registration endpoint work.
 */
export function normalisePassword(raw: string): string {
  if (/^[0-9a-f]{32}$/i.test(raw)) {
    return raw.toLowerCase(); // already MD5
  }
  return md5(raw);
}

/** Strip Trackmania colour/style codes ($xxx, $i, $b, etc.) from a nickname */
export function stripTmCodes(nick: string): string {
  return nick
    .replace(/\$[0-9a-fA-F]{3}/g, '')   // $rgb colour
    .replace(/\$[lLoOwWiIbBuUsS]/g, '')  // style codes
    .replace(/\$\$/g, '$')               // escaped dollar
    .replace(/\$/g, '')                  // stray dollar
    .trim();
}

/** 3-letter ISO nation code list (WOR = World) */
export const VALID_NATIONS = new Set([
  'WOR','AFG','ALB','DZA','AND','AGO','ARG','ARM','AUS','AUT','AZE',
  'BHS','BHR','BGD','BRB','BLR','BEL','BLZ','BEN','BTN','BOL','BIH',
  'BWA','BRA','BRN','BGR','BFA','BDI','CPV','KHM','CMR','CAN','CAF',
  'TCD','CHL','CHN','COL','COM','COD','COK','CRI','HRV','CUB','CYP',
  'CZE','DNK','DJI','DOM','ECU','EGY','SLV','GNQ','ERI','EST','SWZ',
  'ETH','FJI','FIN','FRA','GAB','GMB','GEO','DEU','GHA','GRC','GRD',
  'GTM','GIN','GNB','GUY','HTI','HND','HUN','ISL','IND','IDN','IRN',
  'IRQ','IRL','ISR','ITA','JAM','JPN','JOR','KAZ','KEN','KIR','PRK',
  'KOR','KWT','KGZ','LAO','LVA','LBN','LSO','LBR','LBY','LIE','LTU',
  'LUX','MDG','MWI','MYS','MDV','MLI','MLT','MTQ','MRT','MUS','MEX',
  'MDA','MCO','MNG','MNE','MAR','MOZ','MMR','NAM','NRU','NPL','NLD',
  'NCL','NZL','NIC','NER','NGA','NOR','OMN','PAK','PAN','PNG','PRY',
  'PER','PHL','POL','PRT','QAT','ROU','RUS','RWA','KNA','LCA','VCT',
  'WSM','SMR','STP','SAU','SEN','SRB','SYC','SLE','SGP','SVK','SVN',
  'SLB','SOM','ZAF','SSD','ESP','LKA','SDN','SUR','SWE','CHE','SYR',
  'TWN','TJK','TZA','THA','TLS','TGO','TON','TTO','TUN','TUR','TKM',
  'TUV','UGA','UKR','ARE','GBR','USA','URY','UZB','VUT','VEN','VNM',
  'YEM','ZMB','ZWE',
]);
