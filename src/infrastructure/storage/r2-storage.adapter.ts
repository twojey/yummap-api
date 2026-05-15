import { config } from "../../../config.ts";

// Cloudflare R2 via l'API S3-compatible avec signature AWS v4
export class R2StorageAdapter {
  readonly #endpoint: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #bucket: string;

  constructor() {
    this.#endpoint = `https://${config.r2.accountId}.r2.cloudflarestorage.com`;
    this.#accessKeyId = config.r2.accessKeyId;
    this.#secretAccessKey = config.r2.secretAccessKey;
    this.#bucket = config.r2.bucket;
  }

  // Retourne l'URL publique du fichier uploadé
  async upload(key: string, data: Uint8Array, contentType: string): Promise<string> {
    const url = `${this.#endpoint}/${this.#bucket}/${key}`;
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 8);
    const timeStr = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";

    const headers = await this.#sign("PUT", key, contentType, data, dateStr, timeStr);

    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: data.buffer as ArrayBuffer,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`R2 upload failed: ${response.status} ${body}`);
    }

    return `${config.r2.publicBaseUrl}/${key}`;
  }

  async #sign(
    method: string,
    key: string,
    contentType: string,
    body: Uint8Array,
    dateStr: string,
    amzDate: string,
  ): Promise<Record<string, string>> {
    const host = `${this.#endpoint.replace("https://", "")}`;
    const bodyHash = await this.#sha256hex(body);

    const headers: Record<string, string> = {
      "host": host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": bodyHash,
      "content-type": contentType,
    };

    const sortedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaders.map((h) => `${h}:${headers[h]}`).join("\n") + "\n";
    const signedHeaders = sortedHeaders.join(";");

    const canonicalRequest = [
      method,
      `/${this.#bucket}/${key}`,
      "",
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join("\n");

    const region = "auto";
    const service = "s3";
    const scope = `${dateStr}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      await this.#sha256hex(new TextEncoder().encode(canonicalRequest)),
    ].join("\n");

    const signingKey = await this.#hmacKey(
      await this.#hmacKey(
        await this.#hmacKey(
          await this.#hmacKey(
            new TextEncoder().encode(`AWS4${this.#secretAccessKey}`),
            dateStr,
          ),
          region,
        ),
        service,
      ),
      "aws4_request",
    );

    const signature = await this.#hmacHex(signingKey, stringToSign);
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { ...headers, "authorization": authorization };
  }

  async #sha256hex(data: Uint8Array): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
    return Array.from(new Uint8Array(buf as ArrayBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async #hmacKey(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
    const rawKey = key instanceof Uint8Array ? key.buffer : key;
    const cryptoKey = await crypto.subtle.importKey(
      "raw", rawKey,
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  }

  async #hmacHex(key: ArrayBuffer, data: string): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const buf = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
    return Array.from(new Uint8Array(buf as ArrayBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}
