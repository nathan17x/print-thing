// Minimal, dependency-free IPP/2.0 client (RFC 8010 / 8011).
// Used both to talk to the local CUPS scheduler and directly to network printers.

export const Tag = {
  operation: 0x01,
  job: 0x02,
  end: 0x03,
  printer: 0x04,
  unsupported: 0x05,
  // out-of-band
  unsupportedValue: 0x10,
  unknown: 0x12,
  noValue: 0x13,
  // integer
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  // octet string
  octetString: 0x30,
  dateTime: 0x31,
  resolution: 0x32,
  rangeOfInteger: 0x33,
  begCollection: 0x34,
  textWithLanguage: 0x35,
  nameWithLanguage: 0x36,
  endCollection: 0x37,
  // character string
  textWithoutLanguage: 0x41,
  nameWithoutLanguage: 0x42,
  keyword: 0x44,
  uri: 0x45,
  uriScheme: 0x46,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
  memberAttrName: 0x4a,
} as const;

export const Op = {
  PrintJob: 0x0002,
  ValidateJob: 0x0004,
  CancelJob: 0x0008,
  GetJobAttributes: 0x0009,
  GetJobs: 0x000a,
  GetPrinterAttributes: 0x000b,
} as const;

export const JobState: Record<number, string> = {
  3: "pending",
  4: "pending-held",
  5: "processing",
  6: "processing-stopped",
  7: "canceled",
  8: "aborted",
  9: "completed",
};

export const PrinterState: Record<number, string> = {
  3: "idle",
  4: "processing",
  5: "stopped",
};

const STATUS_NAMES: Record<number, string> = {
  0x0000: "successful-ok",
  0x0001: "successful-ok-ignored-or-substituted-attributes",
  0x0002: "successful-ok-conflicting-attributes",
  0x0400: "client-error-bad-request",
  0x0401: "client-error-forbidden",
  0x0402: "client-error-not-authenticated",
  0x0403: "client-error-not-authorized",
  0x0404: "client-error-not-possible",
  0x0405: "client-error-timeout",
  0x0406: "client-error-not-found",
  0x0407: "client-error-gone",
  0x0408: "client-error-request-entity-too-large",
  0x040a: "client-error-document-format-not-supported",
  0x040b: "client-error-attributes-or-values-not-supported",
  0x0500: "server-error-internal-error",
  0x0501: "server-error-operation-not-supported",
  0x0502: "server-error-service-unavailable",
  0x0503: "server-error-version-not-supported",
  0x0504: "server-error-device-error",
  0x0505: "server-error-temporary-error",
  0x0506: "server-error-not-accepting-jobs",
  0x0507: "server-error-busy",
};

export type IppValue =
  | string
  | number
  | boolean
  | null
  | { x: number; y: number; units: number }
  | { lower: number; upper: number }
  | IppCollection;
export type IppCollection = { [name: string]: IppValue | IppValue[] };
export type IppGroup = Record<string, IppValue | IppValue[]>;

export interface IppResponse {
  version: string;
  statusCode: number;
  status: string;
  requestId: number;
  operation: IppGroup;
  printer: IppGroup[];
  job: IppGroup[];
  unsupported: IppGroup[];
}

export type AttrSpec = [tag: number, name: string, value: IppValue | IppValue[]];

// ---------- encoding ----------

class Writer {
  private chunks: Buffer[] = [];
  u8(n: number) { const b = Buffer.alloc(1); b.writeUInt8(n); this.chunks.push(b); }
  u16(n: number) { const b = Buffer.alloc(2); b.writeUInt16BE(n); this.chunks.push(b); }
  i32(n: number) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.chunks.push(b); }
  raw(b: Buffer) { this.chunks.push(b); }
  str(s: string) { const b = Buffer.from(s, "utf8"); this.u16(b.length); this.raw(b); }
  buffer() { return Buffer.concat(this.chunks); }
}

function encodeValue(w: Writer, tag: number, value: IppValue) {
  switch (tag) {
    case Tag.integer:
    case Tag.enum:
      w.u16(4); w.i32(value as number); break;
    case Tag.boolean:
      w.u16(1); w.u8(value ? 1 : 0); break;
    case Tag.rangeOfInteger: {
      const r = value as { lower: number; upper: number };
      w.u16(8); w.i32(r.lower); w.i32(r.upper); break;
    }
    case Tag.noValue:
    case Tag.unknown:
      w.u16(0); break;
    default:
      w.str(String(value));
  }
}

function encodeAttr(w: Writer, [tag, name, value]: AttrSpec) {
  const values = Array.isArray(value) ? value : [value];
  values.forEach((v, i) => {
    w.u8(tag);
    w.str(i === 0 ? name : "");
    encodeValue(w, tag, v);
  });
}

let requestCounter = 1;

export function encodeRequest(
  op: number,
  groups: { operation: AttrSpec[]; job?: AttrSpec[] },
): Buffer {
  const w = new Writer();
  w.u8(2); w.u8(0); // IPP/2.0
  w.u16(op);
  w.i32(requestCounter++ & 0x7fffffff || 1);
  w.u8(Tag.operation);
  encodeAttr(w, [Tag.charset, "attributes-charset", "utf-8"]);
  encodeAttr(w, [Tag.naturalLanguage, "attributes-natural-language", "en"]);
  groups.operation.forEach((a) => encodeAttr(w, a));
  if (groups.job?.length) {
    w.u8(Tag.job);
    groups.job.forEach((a) => encodeAttr(w, a));
  }
  w.u8(Tag.end);
  return w.buffer();
}

// ---------- decoding ----------

function decodeDate(b: Buffer): string {
  const year = b.readUInt16BE(0);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = String.fromCharCode(b[8]);
  return `${year}-${pad(b[2])}-${pad(b[3])}T${pad(b[4])}:${pad(b[5])}:${pad(b[6])}${sign}${pad(b[9])}:${pad(b[10])}`;
}

function decodeScalar(tag: number, b: Buffer): IppValue {
  switch (tag) {
    case Tag.integer:
    case Tag.enum:
      return b.length >= 4 ? b.readInt32BE(0) : 0;
    case Tag.boolean:
      return b[0] === 1;
    case Tag.rangeOfInteger:
      return { lower: b.readInt32BE(0), upper: b.readInt32BE(4) };
    case Tag.resolution:
      return { x: b.readInt32BE(0), y: b.readInt32BE(4), units: b[8] };
    case Tag.dateTime:
      return decodeDate(b);
    case Tag.textWithLanguage:
    case Tag.nameWithLanguage: {
      const langLen = b.readUInt16BE(0);
      const txtLen = b.readUInt16BE(2 + langLen);
      return b.subarray(4 + langLen, 4 + langLen + txtLen).toString("utf8");
    }
    case Tag.unsupportedValue:
    case Tag.unknown:
    case Tag.noValue:
      return null;
    default:
      return b.toString("utf8");
  }
}

function push(group: IppGroup | IppCollection, name: string, value: IppValue) {
  if (!(name in group)) { group[name] = value; return; }
  const cur = group[name];
  if (Array.isArray(cur)) cur.push(value);
  else group[name] = [cur as IppValue, value];
}

export function decodeResponse(buf: Buffer): IppResponse {
  let off = 0;
  const u8 = () => buf.readUInt8(off++);
  const u16 = () => { const v = buf.readUInt16BE(off); off += 2; return v; };
  const i32 = () => { const v = buf.readInt32BE(off); off += 4; return v; };
  const bytes = (n: number) => { const v = buf.subarray(off, off + n); off += n; return v; };

  const res: IppResponse = {
    version: `${u8()}.${u8()}`,
    statusCode: 0, status: "", requestId: 0,
    operation: {}, printer: [], job: [], unsupported: [],
  };
  res.statusCode = u16();
  res.status = STATUS_NAMES[res.statusCode] ?? `0x${res.statusCode.toString(16)}`;
  res.requestId = i32();

  let group: IppGroup | null = null;
  let lastName = "";

  // Reads the members of a collection; returns once endCollection is consumed.
  const readCollection = (): IppCollection => {
    const coll: IppCollection = {};
    let memberName = "";
    while (off < buf.length) {
      const tag = u8();
      const nameLen = u16(); bytes(nameLen);
      const valLen = u16();
      const val = bytes(valLen);
      if (tag === Tag.endCollection) return coll;
      if (tag === Tag.memberAttrName) { memberName = val.toString("utf8"); continue; }
      const v = tag === Tag.begCollection ? readCollection() : decodeScalar(tag, val);
      push(coll, memberName, v);
    }
    return coll;
  };

  while (off < buf.length) {
    const tag = u8();
    if (tag === Tag.end) break;
    if (tag < 0x10) {
      group = {};
      if (tag === Tag.operation) res.operation = group;
      else if (tag === Tag.job) res.job.push(group);
      else if (tag === Tag.printer) res.printer.push(group);
      else if (tag === Tag.unsupported) res.unsupported.push(group);
      continue;
    }
    const nameLen = u16();
    const name = nameLen ? bytes(nameLen).toString("utf8") : lastName;
    if (nameLen) lastName = name;
    const valLen = u16();
    const val = bytes(valLen);
    const v = tag === Tag.begCollection ? readCollection() : decodeScalar(tag, val);
    if (group) {
      if (nameLen) group[name] = v;
      else push(group, name, v);
    }
  }
  return res;
}

// ---------- transport ----------

export class IppError extends Error {
  constructor(message: string, public response?: IppResponse) { super(message); }
}

/** Converts ipp://, ipps://, http:// URIs into an http(s) URL for the transport. */
export function toHttpUrl(uri: string): string {
  const u = new URL(uri.replace(/^ipps:/, "https:").replace(/^ipp:/, "http:"));
  if (!u.port) u.port = "631";
  return u.toString();
}

export async function ippRequest(
  uri: string,
  op: number,
  groups: { operation: AttrSpec[]; job?: AttrSpec[] },
  opts: { data?: Buffer; timeoutMs?: number; allowError?: boolean } = {},
): Promise<IppResponse> {
  const header = encodeRequest(op, groups);
  const body = opts.data ? Buffer.concat([header, opts.data]) : header;
  const url = toHttpUrl(uri);
  if (url.startsWith("https:")) {
    // Printers almost always use self-signed certificates.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/ipp" },
      body: new Uint8Array(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new IppError(`HTTP ${r.status} ${r.statusText} from ${url}`);
    const res = decodeResponse(Buffer.from(await r.arrayBuffer()));
    if (res.statusCode >= 0x0400 && !opts.allowError) {
      const msg = res.operation["status-message"];
      throw new IppError(`${res.status}${msg ? `: ${msg}` : ""}`, res);
    }
    return res;
  } catch (e) {
    if (e instanceof IppError) throw e;
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err.name === "AbortError") throw new IppError(`Timed out contacting ${url}`);
    throw new IppError(`Cannot reach ${url}: ${err.cause?.code ?? err.cause?.message ?? err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- helpers ----------

export const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

export const asString = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

export const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;
