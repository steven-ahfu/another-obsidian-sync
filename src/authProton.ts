import bcrypt from "bcryptjs";
import { delay } from "./misc";
import { createSRPClient } from "js-srp6a";
import { requestUrl } from "obsidian";

import { log } from "./moreOnLog";

const API_BASE = "https://mail.proton.me/api";
const APP_VERSION = "Other";

// Minimum ms between login attempts — prevents hammering the auth endpoint
// and avoids the "unusual activity" lockout Proton imposes on rapid retries.
const MIN_LOGIN_INTERVAL_MS = 5_000;
let lastLoginAttemptAt = 0;

// Backoff schedule for 429/503 responses (seconds)
const RETRY_WAIT_SECONDS = [2, 4, 8, 16];

export interface ProtonTokens {
    uid: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // epoch ms
    keyPassword: string; // bcrypt+SHA-512 of login password + KeySalt; not the raw password
}

// ---------------------------------------------------------------------------
// HTTP helpers — use Obsidian's requestUrl so it works on all platforms
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HTTP with retry on 429 / 503
// ---------------------------------------------------------------------------

async function apiPostOnce(
    path: string,
    body: object,
    uid?: string,
    accessToken?: string
): Promise<{ status: number; json: Record<string, unknown>; retryAfterSec?: number }> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-pm-appversion": APP_VERSION,
    };
    if (uid) headers["x-pm-uid"] = uid;
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

    const response = await requestUrl({
        url: `${API_BASE}${path}`,
        method: "POST",
        headers,
        body: JSON.stringify(body),
        throw: false, // don't throw on 4xx/5xx — we handle it
    });

    const json = response.json as Record<string, unknown>;
    const retryAfterSec = response.headers?.["retry-after"]
        ? parseInt(response.headers["retry-after"])
        : undefined;

    return { status: response.status, json, retryAfterSec };
}

export async function apiPost(
    path: string,
    body: object,
    uid?: string,
    accessToken?: string
): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < RETRY_WAIT_SECONDS.length; attempt++) {
        const { status, json, retryAfterSec } = await apiPostOnce(path, body, uid, accessToken);

        if (status === 200 || status === 204) {
            return json;
        }

        const isRetryable = status === 429 || status === 503;
        if (!isRetryable || attempt === RETRY_WAIT_SECONDS.length - 1) {
            const msg = (json?.Error as string) ?? (json?.error as string) ?? String(status);
            throw new Error(`Proton API ${path} failed (${status}): ${msg}`);
        }

        const fallbackSec = RETRY_WAIT_SECONDS[attempt];
        const waitSec = Math.max(retryAfterSec ?? 0, fallbackSec);
        log.warn(`[authProton] ${path} got ${status}, retrying in ${waitSec}s (attempt ${attempt + 1}/${RETRY_WAIT_SECONDS.length})`);
        await delay(waitSec * 1000);
    }
    // unreachable, but satisfies TS
    throw new Error(`Proton API ${path} failed after all retries`);
}

// GET helper (no retry — used only at login time where we control the flow)
export async function apiGet(
    path: string,
    uid: string,
    accessToken: string
): Promise<Record<string, unknown>> {
    const response = await requestUrl({
        url: `${API_BASE}${path}`,
        method: "GET",
        headers: {
            "x-pm-appversion": APP_VERSION,
            "x-pm-uid": uid,
            "Authorization": `Bearer ${accessToken}`,
        },
        throw: false,
    });
    if (response.status !== 200) {
        const msg = (response.json as any)?.Error ?? String(response.status);
        throw new Error(`Proton API GET ${path} failed (${response.status}): ${msg}`);
    }
    return response.json as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Proton's custom password hash: bcrypt + SHA-512 expansion
// ---------------------------------------------------------------------------

export async function computeProtonKeyPassword(password: string, salt: string): Promise<string> {
    // Proton's bcrypt salt format: $2y$10$<22-char base64 salt>
    // The API-returned salt is base64; bcryptjs needs it in its own encoding
    const bcryptResult = await bcrypt.hash(password, `$2y$10$${salt.replace(/\+/g, ".")}`);

    // SHA-512 expansion: 4 rounds with byte suffix 0-3, concatenated
    const encoder = new TextEncoder();
    const chunks = await Promise.all(
        [0, 1, 2, 3].map(async (i) => {
            const data = encoder.encode(bcryptResult + String.fromCharCode(i));
            const hash = await crypto.subtle.digest("SHA-512", data);
            return new Uint8Array(hash);
        })
    );

    const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }
    return btoa(String.fromCharCode(...combined));
}

// Fetch the KeySalt for a freshly authenticated session, then derive the
// key password.  Called once at login — the result is stored in config so
// we don't need to store the raw login password.
export async function fetchKeyPassword(
    uid: string,
    accessToken: string,
    loginPassword: string
): Promise<string> {
    const res = await apiGet("/core/v4/users", uid, accessToken);
    const keySalt = ((res.User as any)?.KeySalt as string | undefined) ?? "";
    if (!keySalt) {
        log.warn("[authProton] no KeySalt in user response — address key decryption will fail");
        return "";
    }
    log.debug("[authProton] deriving key password from KeySalt");
    return computeProtonKeyPassword(loginPassword, keySalt);
}

// ---------------------------------------------------------------------------
// SRPModule implementation passed to the Drive SDK
// ---------------------------------------------------------------------------

export function createSRPModule() {
    return {
        async getSrp(
            version: number,
            modulus: string,
            serverEphemeral: string,
            salt: string,
            password: string
        ): Promise<{ expectedServerProof: string; clientProof: string; clientEphemeral: string }> {
            log.debug(`[authProton] getSrp version=${version}`);
            const srpClient = createSRPClient("SHA-512", 2048);
            const keyPassword = await computeProtonKeyPassword(password, salt);
            const clientEph = srpClient.generateEphemeral();
            const session = await srpClient.deriveSession(
                clientEph.secret,
                serverEphemeral,
                salt,
                "",
                keyPassword
            );
            return {
                clientEphemeral: clientEph.public,
                clientProof: session.proof,
                expectedServerProof: session.key,
            };
        },

        async getSrpVerifier(
            _password: string
        ): Promise<{ modulusId: string; version: number; salt: string; verifier: string }> {
            throw new Error("getSrpVerifier not implemented");
        },

        async computeKeyPassword(password: string, salt: string): Promise<string> {
            return computeProtonKeyPassword(password, salt);
        },

        generateKeySalt(): string {
            const bytes = crypto.getRandomValues(new Uint8Array(16));
            return btoa(String.fromCharCode(...bytes));
        },
    };
}

// ---------------------------------------------------------------------------
// Auth info response shape
// ---------------------------------------------------------------------------

interface AuthInfoResponse {
    Version: number;
    Modulus: string;
    ServerEphemeral: string;
    Salt: string;
    SRPSession: string;
}

interface AuthResponse {
    UID: string;
    AccessToken: string;
    RefreshToken: string;
    ExpiresIn: number;
    "2FA": { Enabled: number }; // bit flags: 1=TOTP, 2=FIDO2
}

// ---------------------------------------------------------------------------
// Login: username + password + optional TOTP → tokens
// ---------------------------------------------------------------------------

export async function protonLogin(
    username: string,
    password: string,
    totpCode?: string
): Promise<ProtonTokens> {
    // Enforce minimum interval between login attempts to avoid Proton's
    // "unusual activity" lockout triggered by rapid repeated auth requests.
    const msSinceLast = Date.now() - lastLoginAttemptAt;
    if (msSinceLast < MIN_LOGIN_INTERVAL_MS) {
        const wait = MIN_LOGIN_INTERVAL_MS - msSinceLast;
        log.warn(`[authProton] rate-limiting login: waiting ${wait}ms before next attempt`);
        await delay(wait);
    }
    lastLoginAttemptAt = Date.now();
    log.debug(`[authProton] login username=${username}`);

    // Step 1: get auth info
    const infoRes = await apiPost("/auth/v4/info", { Username: username });
    const info = infoRes as unknown as AuthInfoResponse;

    // Step 2: compute SRP proofs
    const srp = createSRPModule();
    const { clientEphemeral, clientProof } = await srp.getSrp(
        info.Version,
        info.Modulus,
        info.ServerEphemeral,
        info.Salt,
        password
    );

    // Step 3: submit proofs
    const authRes = (await apiPost("/auth/v4", {
        Username: username,
        ClientEphemeral: clientEphemeral,
        ClientProof: clientProof,
        SRPSession: info.SRPSession,
    })) as unknown as AuthResponse;

    // Step 4: handle 2FA if required (bit flag 1 = TOTP enabled)
    const twoFAEnabled = authRes["2FA"]?.Enabled ?? 0;
    if (twoFAEnabled & 1) {
        if (!totpCode) {
            throw new Error("Proton account has 2FA enabled but no TOTP code was provided");
        }
        log.debug(`[authProton] submitting 2FA code`);
        await apiPost("/auth/v4/2fa", { TwoFactorCode: totpCode }, authRes.UID, authRes.AccessToken);
    }

    log.debug(`[authProton] login success uid=${authRes.UID}`);

    // Derive key password while we still have the login password in scope.
    const keyPassword = await fetchKeyPassword(authRes.UID, authRes.AccessToken, password);

    const expiresIn = authRes.ExpiresIn ?? 3600;
    return {
        uid: authRes.UID,
        accessToken: authRes.AccessToken,
        refreshToken: authRes.RefreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
        keyPassword,
    };
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

// Token refresh is called automatically during sync — apply the same retry
// backoff so a transient 429 doesn't abort an in-progress sync.
export async function protonRefreshToken(tokens: ProtonTokens): Promise<ProtonTokens> {
    log.debug(`[authProton] refreshing token uid=${tokens.uid}`);

    const res = await apiPost(
        "/auth/v4/refresh",
        {
            ResponseType: "token",
            GrantType: "refresh_token",
            RefreshToken: tokens.refreshToken,
            RedirectURI: "https://proton.me",
        },
        tokens.uid
    );

    const expiresIn = (res.ExpiresIn as number) ?? 3600;
    return {
        uid: tokens.uid,
        accessToken: res.AccessToken as string,
        refreshToken: res.RefreshToken as string,
        expiresAt: Date.now() + expiresIn * 1000,
        keyPassword: tokens.keyPassword, // unchanged on refresh
    };
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function protonLogout(tokens: ProtonTokens): Promise<void> {
    log.debug(`[authProton] logout uid=${tokens.uid}`);
    try {
        await apiPost("/auth/v4", {}, tokens.uid, tokens.accessToken);
    } catch {
        // best-effort
    }
}
