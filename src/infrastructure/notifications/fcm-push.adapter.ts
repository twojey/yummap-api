import { config } from "../../../config.ts";
import type { IPushProvider, PushMessage, PushSendResult } from "../../domain/notification/push.provider.ts";

export class FcmPushAdapter implements IPushProvider {
  async send(tokens: string[], message: PushMessage): Promise<PushSendResult> {
    if (tokens.length === 0) {
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }

    const accessToken = await this.#getAccessToken();
    const projectId = config.fcm.projectId;

    const results = await Promise.allSettled(
      tokens.map((token) =>
        fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: message.title, body: message.body },
              data: message.data ?? {},
            },
          }),
        })
      ),
    );

    let successCount = 0;
    let failureCount = 0;
    const invalidTokens: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled" && result.value.ok) {
        successCount++;
      } else {
        failureCount++;
        const body = result.status === "fulfilled"
          ? await result.value.json() as Record<string, { details?: Array<{ errorCode?: string }> }>
          : null;
        if (body?.error?.details?.some((d) => d.errorCode === "INVALID_ARGUMENT")) {
          invalidTokens.push(tokens[i]);
        }
      }
    }

    return { successCount, failureCount, invalidTokens };
  }

  async #getAccessToken(): Promise<string> {
    // JWT OAuth2 pour FCM v1 API
    const serviceAccount = JSON.parse(config.fcm.serviceAccountKey) as {
      client_email: string;
      private_key: string;
    };

    const now = Math.floor(Date.now() / 1000);
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = btoa(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }));

    // Note: signing JWT with RSA-SHA256 requires crypto.subtle
    // In production, use a proper JWT library
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      this.#pemToBuffer(serviceAccount.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    const jwt = `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    const tokenData = await tokenRes.json() as { access_token: string };
    return tokenData.access_token;
  }

  #pemToBuffer(pem: string): ArrayBuffer {
    const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    const binary = atob(b64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
    return buffer.buffer;
  }
}
