import { createHash } from "node:crypto";
import { mozillaUrl, SHA256 } from "./amo-policy.ts";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** No auth on downloads; every redirect rechecks origin, size and deadline. */
export async function downloadSigned(
  url: string,
  expected: string,
  request = fetch,
): Promise<Buffer> {
  if (!SHA256.test(expected)) throw new Error("Invalid expected SHA-256");
  let next = mozillaUrl(url);
  const signal = AbortSignal.timeout(60_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response: Response;
    try {
      response = await request(next, {
        redirect: "manual",
        signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new Error("Mozilla download failed (network or timeout)");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Missing Mozilla redirect target");
      next = mozillaUrl(new URL(location, next).href);
      continue;
    }
    if (response.status !== 200 || !response.body)
      throw new Error(`Mozilla download HTTP ${response.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 25_000_000) throw new Error("Mozilla download exceeds size limit");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (sha256(bytes) !== expected) throw new Error("Mozilla download SHA-256 mismatch");
    return bytes;
  }
  throw new Error("Too many Mozilla redirects");
}
