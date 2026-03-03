/**
 * XML-RPC parser and generator for the Trackmania United master server.
 *
 * The parser is a recursive descent over the raw XML string – no DOM,
 * no external dependencies.  It handles all XML-RPC value types:
 *   string, int/i4/i8, double, boolean, nil, dateTime.iso8601, base64,
 *   array, struct
 *
 * The generator produces spec-compliant XML-RPC methodResponse payloads.
 */

export type RpcValue =
  | string
  | number
  | boolean
  | null
  | Date
  | RpcValue[]
  | { [k: string]: RpcValue };

export interface RpcCall {
  method: string;
  params: RpcValue[];
}

export interface RpcFault {
  faultCode: number;
  faultString: string;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse an XML-RPC methodCall body.
 * Returns null if the body is not recognisable XML-RPC.
 */
export function parseCall(xml: string): RpcCall | null {
  try {
    const methodName = extractTag(xml, 'methodName');
    if (!methodName) return null;

    const paramsXml = extractTagContent(xml, 'params');
    if (!paramsXml) return { method: methodName.trim(), params: [] };

    const params: RpcValue[] = [];
    let offset = 0;
    while (true) {
      const paramIdx = paramsXml.indexOf('<param>', offset);
      if (paramIdx === -1) break;
      const paramEnd = paramsXml.indexOf('</param>', paramIdx);
      if (paramEnd === -1) break;
      const paramBody = paramsXml.slice(paramIdx + 7, paramEnd);
      const valueStart = paramBody.indexOf('<value>');
      const valueEnd   = paramBody.lastIndexOf('</value>');
      if (valueStart !== -1) {
        const inner = paramBody.slice(valueStart + 7, valueEnd === -1 ? undefined : valueEnd);
        params.push(parseValue(inner.trim()));
      }
      offset = paramEnd + 8;
    }

    return { method: methodName.trim(), params };
  } catch {
    return null;
  }
}

function parseValue(inner: string): RpcValue {
  // Bare text (no type tag) → string
  if (!inner.startsWith('<')) {
    return unescapeXml(inner);
  }

  // Determine type tag
  const tagEnd = inner.indexOf('>');
  if (tagEnd === -1) return unescapeXml(inner);

  const rawTag = inner.slice(1, tagEnd).trim().toLowerCase();

  // Self-closing nil
  if (rawTag === 'nil' || rawTag === 'nil/') return null;

  const closeAngle = inner.indexOf('</', tagEnd);
  const content = closeAngle === -1
    ? inner.slice(tagEnd + 1)
    : inner.slice(tagEnd + 1, closeAngle);

  switch (rawTag) {
    case 'string':
      return unescapeXml(content);

    case 'int':
    case 'i4':
    case 'i8': {
      const n = parseInt(content.trim(), 10);
      return isNaN(n) ? 0 : n;
    }

    case 'double': {
      const f = parseFloat(content.trim());
      return isNaN(f) ? 0 : f;
    }

    case 'boolean':
      return content.trim() === '1';

    case 'datetime.iso8601':
      return new Date(content.trim());

    case 'base64':
      return Buffer.from(content.trim(), 'base64').toString('utf8');

    case 'array':
      return parseArray(inner);

    case 'struct':
      return parseStruct(inner);

    default:
      // Unknown tag – return content as string
      return unescapeXml(content);
  }
}

function parseArray(xml: string): RpcValue[] {
  const dataContent = extractTagContent(xml, 'data');
  if (!dataContent) return [];

  const result: RpcValue[] = [];
  let offset = 0;
  while (true) {
    const vStart = dataContent.indexOf('<value>', offset);
    if (vStart === -1) break;
    const inner = dataContent.slice(vStart + 7);
    // Find the matching </value> – we need to count nesting
    const closeIdx = findClosingValue(inner);
    const valueBody = closeIdx === -1 ? inner : inner.slice(0, closeIdx);
    result.push(parseValue(valueBody.trim()));
    offset = vStart + 7 + (closeIdx === -1 ? inner.length : closeIdx + 8);
  }
  return result;
}

function parseStruct(xml: string): { [k: string]: RpcValue } {
  const result: { [k: string]: RpcValue } = {};
  let offset = 0;
  while (true) {
    const mStart = xml.indexOf('<member>', offset);
    if (mStart === -1) break;
    const mEnd = xml.indexOf('</member>', mStart);
    if (mEnd === -1) break;
    const member = xml.slice(mStart + 8, mEnd);

    // Key: <name> or (legacy) <n>
    let key = extractTag(member, 'name');
    if (!key) key = extractTag(member, 'n');
    if (!key) { offset = mEnd + 9; continue; }

    const vStart = member.indexOf('<value>');
    if (vStart !== -1) {
      const inner = member.slice(vStart + 7);
      const closeIdx = findClosingValue(inner);
      const valueBody = closeIdx === -1 ? inner : inner.slice(0, closeIdx);
      result[unescapeXml(key.trim())] = parseValue(valueBody.trim());
    }
    offset = mEnd + 9;
  }
  return result;
}

/**
 * Find the index of the closing </value> that matches an opening <value>
 * already consumed (i.e. `xml` starts just after the opening tag's `>`).
 * Returns the index of '<' in '</value>' or -1.
 */
function findClosingValue(xml: string): number {
  let depth = 0;
  let i = 0;
  while (i < xml.length) {
    if (xml.startsWith('<value>', i)) { depth++; i += 7; continue; }
    if (xml.startsWith('</value>', i)) {
      if (depth === 0) return i;
      depth--;
      i += 8;
      continue;
    }
    i++;
  }
  return -1;
}

/** Extract the text content of the first occurrence of <tag>…</tag> */
function extractTag(xml: string, tag: string): string | null {
  const open  = `<${tag}>`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open);
  if (start === -1) return null;
  const end = xml.indexOf(close, start + open.length);
  if (end === -1) return xml.slice(start + open.length);
  return xml.slice(start + open.length, end);
}

/** Same as extractTag but searches from any position and returns full inner xml */
function extractTagContent(xml: string, tag: string): string | null {
  return extractTag(xml, tag);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ─── Generator ────────────────────────────────────────────────────────────────

export function successResponse(value: RpcValue): string {
  return `<?xml version="1.0" encoding="utf-8"?>\r\n` +
    `<methodResponse>\r\n` +
    `  <params><param><value>${toXml(value)}</value></param></params>\r\n` +
    `</methodResponse>`;
}

export function faultResponse(code: number, message: string): string {
  const struct = toXml({ faultCode: code, faultString: message });
  return `<?xml version="1.0" encoding="utf-8"?>\r\n` +
    `<methodResponse>\r\n` +
    `  <fault><value>${struct}</value></fault>\r\n` +
    `</methodResponse>`;
}

function toXml(v: RpcValue): string {
  if (v === null || v === undefined) return '<nil/>';
  if (typeof v === 'boolean')  return `<boolean>${v ? 1 : 0}</boolean>`;
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? `<int>${v}</int>`
      : `<double>${v}</double>`;
  }
  if (typeof v === 'string')   return `<string>${escapeXml(v)}</string>`;
  if (v instanceof Date)       return `<dateTime.iso8601>${v.toISOString()}</dateTime.iso8601>`;

  if (Array.isArray(v)) {
    const items = v.map(i => `<value>${toXml(i)}</value>`).join('');
    return `<array><data>${items}</data></array>`;
  }

  // object → struct
  const members = Object.entries(v)
    .map(([k, val]) =>
      `<member><name>${escapeXml(k)}</name><value>${toXml(val)}</value></member>`)
    .join('');
  return `<struct>${members}</struct>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}
