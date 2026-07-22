export type StripeSignature = { timestamp: number; signatures: string[] };

export function parseStripeSignature(header: string): StripeSignature | null {
  const values = new Map<string, string[]>();
  for (const item of header.split(",")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const timestamp = Number(values.get("t")?.[0]);
  const signatures = values.get("v1") ?? [];
  return Number.isSafeInteger(timestamp) && signatures.length ? { timestamp, signatures } : null;
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
) {
  const parsed = parseStripeSignature(header);
  if (!parsed || !secret || Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds)
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${parsed.timestamp}.${payload}`),
  );
  const expected = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return parsed.signatures.some((signature) => constantTimeEqual(expected, signature));
}
