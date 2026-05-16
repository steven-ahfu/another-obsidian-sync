import {
    MemoryCache,
    NodeType,
    OpenPGPCryptoWithCryptoProxy,
    ProtonDriveClient,
    type MaybeNode,
    type NodeEntity,
    type ProtonDriveHTTPClient,
    type ProtonDriveHTTPClientBlobRequest,
    type ProtonDriveHTTPClientJsonRequest,
} from "@protontech/drive-sdk";
import type { ProtonDriveAccount, ProtonDriveAccountAddress } from "@protontech/drive-sdk";
// @ts-ignore — @protontech/crypto ships raw TS source; import resolves at runtime via webpack extensionAlias
import { Api as CryptoApi } from "@protontech/crypto/proxy/endpoint/api.ts";
import { requestUrl } from "obsidian";

import type { Entity, ProtondriveConfig } from "./baseTypes";
import { FakeFs } from "./fsAll";
import { protonRefreshToken, createSRPModule, apiGet } from "./authProton";
import { log } from "./moreOnLog";

// ---------------------------------------------------------------------------
// Public defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PROTONDRIVE_CONFIG: ProtondriveConfig = {
    username: "",
    uid: "",
    accessToken: "",
    refreshToken: "",
    accessTokenExpiresAt: 0,
    keyPassword: "",
    remoteBaseDir: "",
};

// ---------------------------------------------------------------------------
// HTTP client — wraps Obsidian's requestUrl (works on all platforms)
// ---------------------------------------------------------------------------

const APP_VERSION = "Other";
const API_BASE = "https://drive-api.proton.me";

class ObsidianProtonHttpClient implements ProtonDriveHTTPClient {
    constructor(
        private getUid: () => string,
        private getAccessToken: () => string
    ) {}

    private buildHeaders(incoming: Headers): Record<string, string> {
        const out: Record<string, string> = { "x-pm-appversion": APP_VERSION };
        const uid = this.getUid();
        const tok = this.getAccessToken();
        if (uid) out["x-pm-uid"] = uid;
        if (tok) out["Authorization"] = `Bearer ${tok}`;
        incoming.forEach((v, k) => {
            if (k.toLowerCase() !== "x-pm-appversion") out[k] = v;
        });
        return out;
    }

    async fetchJson(req: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
        log.debug(`[fsProtondrive] http ${req.method} ${req.url}`);
        const headers = this.buildHeaders(req.headers);
        const body = req.json ? JSON.stringify(req.json) : (req.body as string | ArrayBuffer | undefined);
        if (req.json) headers["Content-Type"] = "application/json";
        const res = await requestUrl({
            url: req.url.startsWith("http") ? req.url : `${API_BASE}${req.url}`,
            method: req.method,
            headers,
            body,
            throw: false,
        });
        return new Response(JSON.stringify(res.json), { status: res.status });
    }

    async fetchBlob(req: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
        log.debug(`[fsProtondrive] http blob ${req.method} ${req.url}`);
        const headers = this.buildHeaders(req.headers);
        const res = await requestUrl({
            url: req.url.startsWith("http") ? req.url : `${API_BASE}${req.url}`,
            method: req.method,
            headers,
            body: req.body as string | ArrayBuffer | undefined,
            throw: false,
        });
        return new Response(res.arrayBuffer, { status: res.status });
    }
}

// ---------------------------------------------------------------------------
// ProtonDriveAccount — fetches and decrypts address keys on demand
// ---------------------------------------------------------------------------

class ProtonDriveAccountImpl implements ProtonDriveAccount {
    private cachedAddresses: ProtonDriveAccountAddress[] | null = null;

    constructor(
        private readonly getUid: () => string,
        private readonly getAccessToken: () => string,
        private readonly keyPassword: string,
        private readonly cryptoApi: CryptoApi
    ) {}

    async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
        const addrs = await this.getOwnAddresses();
        if (!addrs[0]) throw new Error("[fsProtondrive] no Proton addresses found");
        return addrs[0];
    }

    async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
        if (this.cachedAddresses) return this.cachedAddresses;
        log.debug("[fsProtondrive] fetching address keys");

        // 1. Fetch and decrypt the user's primary key (encrypts address tokens)
        const userRes = await apiGet("/core/v4/keys/user", this.getUid(), this.getAccessToken());
        const rawUserKeys = ((userRes.User as any)?.Keys ?? []) as Array<{
            ID: string;
            PrivateKey: string;
            Primary: number;
        }>;

        const userKeys = await Promise.all(
            rawUserKeys.map(async (k) => {
                try {
                    return await this.cryptoApi.importPrivateKey({
                        armoredKey: k.PrivateKey,
                        passphrase: this.keyPassword,
                    });
                } catch (e) {
                    log.warn(`[fsProtondrive] failed to decrypt user key ${k.ID}: ${e}`);
                    return null;
                }
            })
        );
        const validUserKeys = userKeys.filter((k: unknown): k is NonNullable<typeof k> => k !== null);
        if (validUserKeys.length === 0) {
            throw new Error("[fsProtondrive] could not decrypt any user keys — check keyPassword");
        }

        // 2. Fetch address list
        const addrRes = await apiGet("/core/v4/addresses", this.getUid(), this.getAccessToken());
        const rawAddresses = (addrRes.Addresses ?? []) as Array<{
            ID: string;
            Email: string;
            Keys: Array<{ ID: string; PrivateKey: string; Token: string }>;
        }>;

        // 3. Decrypt each address key's Token (encrypted to user key), then decrypt the address key
        const addresses: ProtonDriveAccountAddress[] = [];
        for (const addr of rawAddresses) {
            const decryptedKeys: { id: string; key: import("@protontech/drive-sdk/dist/crypto/interface").PrivateKey }[] = [];
            for (const k of (addr.Keys ?? [])) {
                try {
                    const tokenResult = await this.cryptoApi.decryptMessage({
                        armoredMessage: k.Token,
                        decryptionKeys: validUserKeys,
                        format: "utf8",
                    });
                    const addrKey = await this.cryptoApi.importPrivateKey({
                        armoredKey: k.PrivateKey,
                        passphrase: tokenResult.data as string,
                    });
                    decryptedKeys.push({ id: k.ID, key: addrKey });
                } catch (e) {
                    log.warn(`[fsProtondrive] failed to decrypt address key ${k.ID}: ${e}`);
                }
            }
            if (decryptedKeys.length > 0) {
                addresses.push({
                    email: addr.Email,
                    addressId: addr.ID,
                    primaryKeyIndex: 0,
                    keys: decryptedKeys,
                });
            }
        }

        if (addresses.length === 0) {
            throw new Error("[fsProtondrive] no usable address keys found");
        }
        log.debug(`[fsProtondrive] loaded ${addresses.length} address(es)`);
        this.cachedAddresses = addresses;
        return addresses;
    }

    async getOwnAddress(emailOrId: string): Promise<ProtonDriveAccountAddress> {
        const addrs = await this.getOwnAddresses();
        const found = addrs.find((a) => a.email === emailOrId || a.addressId === emailOrId);
        if (!found) throw new Error(`[fsProtondrive] address not found: ${emailOrId}`);
        return found;
    }

    async hasProtonAccount(_email: string): Promise<boolean> { return false; }
    async getPublicKeys(_email: string): Promise<never[]> { return []; }
}

// ---------------------------------------------------------------------------
// FakeFsProtondrive
// ---------------------------------------------------------------------------

export class FakeFsProtondrive extends FakeFs {
    readonly serviceType = "protondrive" as const;

    private driveClient: ProtonDriveClient | null = null;
    private baseFolderUid: string | null = null;
    private pathCache: Map<string, string> = new Map();

    constructor(
        private config: ProtondriveConfig,
        private saveUpdatedConfig: () => Promise<any>
    ) {
        super();
    }

    // -----------------------------------------------------------------------
    // Init (called by syncV3 before any operations)
    // -----------------------------------------------------------------------

    async initClient(): Promise<void> {
        log.debug(`[fsProtondrive] init username=${this.config.username}`);
        await this.ensureTokenFresh();
        this.driveClient = this.buildClient();

        const rootResult = await this.driveClient.getMyFilesRootFolder();
        const root = unwrapNode(rootResult);
        log.debug(`[fsProtondrive] root uid=${root.uid}`);

        const baseDir = this.config.remoteBaseDir;
        this.baseFolderUid = baseDir
            ? await this.resolveOrCreatePath(root.uid, baseDir)
            : root.uid;
        log.debug(`[fsProtondrive] base folder uid=${this.baseFolderUid}`);
    }

    // -----------------------------------------------------------------------
    // FakeFs interface
    // -----------------------------------------------------------------------

    async walk(): Promise<Entity[]> {
        await this.assertReady();
        log.debug(`[fsProtondrive] walk baseDir=${this.config.remoteBaseDir}`);
        const entities: Entity[] = [];
        await this.collectChildren(this.baseFolderUid!, "", entities);
        log.debug(`[fsProtondrive] walk: found ${entities.length} entities`);
        return entities;
    }

    async walkPartial(): Promise<Entity[]> {
        // Proton has no partial listing API — same as full walk
        return this.walk();
    }

    async stat(key: string): Promise<Entity> {
        await this.assertReady();
        const uid = await this.resolvePath(key.replace(/\/$/, ""));
        if (!uid) throw new Error(`[fsProtondrive] stat: not found key=${key}`);
        const node = unwrapNode(await this.driveClient!.getNode(uid));
        return nodeToEntity(node, key);
    }

    async mkdir(key: string, mtime?: number, _ctime?: number): Promise<Entity> {
        await this.assertReady();
        log.debug(`[fsProtondrive] mkdir key=${key}`);
        const clean = key.replace(/\/$/, "");
        const uid = await this.resolveOrCreatePath(this.baseFolderUid!, clean);
        const node = unwrapNode(await this.driveClient!.getNode(uid));
        return nodeToEntity(node, key);
    }

    async writeFile(key: string, content: ArrayBuffer, mtime: number, _ctime: number): Promise<Entity> {
        await this.assertReady();
        log.debug(`[fsProtondrive] writeFile key=${key} size=${content.byteLength}`);

        const parts = key.split("/");
        const filename = parts.pop()!;
        const parentUid = parts.length > 0
            ? await this.resolveOrCreatePath(this.baseFolderUid!, parts.join("/"))
            : this.baseFolderUid!;

        // Remove existing file to avoid collision
        const existing = await this.findChildByName(parentUid, filename);
        if (existing) {
            await this.driveClient!.trashNodes([existing.uid]);
            this.pathCache.delete(key);
        }

        const uploader = await this.driveClient!.getFileUploader(parentUid, filename, {
            mediaType: "application/octet-stream",
            expectedSize: content.byteLength,
            modificationTime: new Date(mtime),
        });

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(content));
                controller.close();
            },
        });

        const controller = await uploader.uploadFromStream(stream, []);
        const { nodeUid } = await controller.completion();
        log.debug(`[fsProtondrive] writeFile done key=${key} uid=${nodeUid}`);

        this.pathCache.set(key, nodeUid);
        const node = unwrapNode(await this.driveClient!.getNode(nodeUid));
        return nodeToEntity(node, key);
    }

    async readFile(key: string): Promise<ArrayBuffer> {
        await this.assertReady();
        log.debug(`[fsProtondrive] readFile key=${key}`);
        const uid = await this.resolvePath(key);
        if (!uid) throw new Error(`[fsProtondrive] readFile: not found key=${key}`);

        const downloader = await this.driveClient!.getFileDownloader(uid);
        const chunks: Uint8Array[] = [];
        const writable = new WritableStream<Uint8Array>({ write(chunk) { chunks.push(chunk); } });
        const controller = downloader.downloadToStream(writable);
        await controller.completion();

        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        log.debug(`[fsProtondrive] readFile done key=${key} size=${out.byteLength}`);
        return out.buffer;
    }

    async rename(key1: string, key2: string, mtime: number, _ctime: number): Promise<void> {
        await this.assertReady();
        log.debug(`[fsProtondrive] rename key1=${key1} key2=${key2}`);
        const uid = await this.resolvePath(key1.replace(/\/$/, ""));
        if (!uid) throw new Error(`[fsProtondrive] rename: not found key=${key1}`);

        const newParts = key2.replace(/\/$/, "").split("/");
        const newName = newParts.pop()!;
        const newParentPath = newParts.join("/");

        // Rename if same parent, move+rename otherwise
        const newParentUid = newParentPath
            ? await this.resolveOrCreatePath(this.baseFolderUid!, newParentPath)
            : this.baseFolderUid!;

        await this.driveClient!.renameNode(uid, newName);
        const oldParts = key1.replace(/\/$/, "").split("/");
        oldParts.pop();
        const oldParentPath = oldParts.join("/");
        if (oldParentPath !== newParentPath) {
            await this.driveClient!.moveNodes([uid], newParentUid);
        }

        this.pathCache.delete(key1.replace(/\/$/, ""));
        this.pathCache.set(key2.replace(/\/$/, ""), uid);
        log.debug(`[fsProtondrive] rename done`);
    }

    async rm(key: string): Promise<void> {
        await this.assertReady();
        log.debug(`[fsProtondrive] rm key=${key}`);
        const uid = await this.resolvePath(key.replace(/\/$/, ""));
        if (!uid) {
            log.debug(`[fsProtondrive] rm: already gone key=${key}`);
            return;
        }
        await this.driveClient!.trashNodes([uid]);
        this.pathCache.delete(key.replace(/\/$/, ""));
        log.debug(`[fsProtondrive] rm done key=${key}`);
    }

    async getUserDisplayName(): Promise<string> {
        return this.config.username || "Proton Drive";
    }

    allowEmptyFile(): boolean {
        return false; // Proton rejects zero-byte uploads
    }

    // -----------------------------------------------------------------------
    // Connectivity check (used by settings UI)
    // -----------------------------------------------------------------------

    async checkConnectivity(): Promise<{ ok: boolean; msg?: string }> {
        log.debug(`[fsProtondrive] checkConnectivity`);
        try {
            await this.ensureTokenFresh();
            const client = this.buildClient();
            await client.getMyFilesRootFolder();
            return { ok: true };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log.debug(`[fsProtondrive] checkConnectivity failed: ${msg}`);
            return { ok: false, msg };
        }
    }

    // -----------------------------------------------------------------------
    // Token management
    // -----------------------------------------------------------------------

    async ensureTokenFresh(): Promise<void> {
        if (!this.config.refreshToken) {
            throw new Error("Proton Drive: not authenticated. Please log in from plugin settings.");
        }
        const bufferMs = 60_000;
        if (this.config.accessTokenExpiresAt - Date.now() > bufferMs) return;

        log.debug(
            `[fsProtondrive] token refresh triggered, expires=${new Date(this.config.accessTokenExpiresAt).toISOString()}`
        );
        const fresh = await protonRefreshToken({
            uid: this.config.uid,
            accessToken: this.config.accessToken,
            refreshToken: this.config.refreshToken,
            expiresAt: this.config.accessTokenExpiresAt,
            keyPassword: this.config.keyPassword,
        });
        this.config.uid = fresh.uid;
        this.config.accessToken = fresh.accessToken;
        this.config.refreshToken = fresh.refreshToken;
        this.config.accessTokenExpiresAt = fresh.expiresAt;
        await this.saveUpdatedConfig();
        log.debug(`[fsProtondrive] token refreshed, new expiry=${new Date(fresh.expiresAt).toISOString()}`);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private buildClient(): ProtonDriveClient {
        const httpClient = new ObsidianProtonHttpClient(
            () => this.config.uid,
            () => this.config.accessToken
        );
        const cryptoApi = new CryptoApi();
        const account = new ProtonDriveAccountImpl(
            () => this.config.uid,
            () => this.config.accessToken,
            this.config.keyPassword,
            cryptoApi
        );
        return new ProtonDriveClient({
            httpClient,
            entitiesCache: new MemoryCache(),
            cryptoCache: new MemoryCache(),
            account,
            openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(cryptoApi),
            srpModule: createSRPModule(),
        });
    }

    private async assertReady(): Promise<void> {
        if (!this.driveClient || !this.baseFolderUid) {
            await this.initClient();
        }
    }

    private async collectChildren(
        parentUid: string,
        pathPrefix: string,
        out: Entity[]
    ): Promise<void> {
        for await (const maybeNode of this.driveClient!.iterateFolderChildren(parentUid)) {
            const node = unwrapNode(maybeNode);
            const relPath = pathPrefix ? `${pathPrefix}/${node.name}` : node.name;

            if (node.type === NodeType.Folder) {
                out.push({ key: `${relPath}/`, synthesizedFolder: true });
                this.pathCache.set(relPath, node.uid);
                await this.collectChildren(node.uid, relPath, out);
            } else {
                out.push(nodeToEntity(node, relPath));
                this.pathCache.set(relPath, node.uid);
            }
        }
    }

    private async resolvePath(key: string): Promise<string | null> {
        const clean = key.replace(/\/$/, "");
        if (!clean) return this.baseFolderUid;
        if (this.pathCache.has(clean)) return this.pathCache.get(clean)!;

        const parts = clean.split("/").filter(Boolean);
        let currentUid = this.baseFolderUid!;
        for (const part of parts) {
            const child = await this.findChildByName(currentUid, part);
            if (!child) return null;
            currentUid = child.uid;
        }
        this.pathCache.set(clean, currentUid);
        return currentUid;
    }

    private async resolveOrCreatePath(rootUid: string, subPath: string): Promise<string> {
        if (!subPath) return rootUid;
        const parts = subPath.split("/").filter(Boolean);
        let currentUid = rootUid;
        let built = "";

        for (const part of parts) {
            built = built ? `${built}/${part}` : part;
            if (this.pathCache.has(built)) {
                currentUid = this.pathCache.get(built)!;
                continue;
            }
            const child = await this.findChildByName(currentUid, part);
            if (child) {
                currentUid = child.uid;
            } else {
                const created = unwrapNode(await this.driveClient!.createFolder(currentUid, part));
                currentUid = created.uid;
                log.debug(`[fsProtondrive] created folder ${built} uid=${currentUid}`);
            }
            this.pathCache.set(built, currentUid);
        }
        return currentUid;
    }

    private async findChildByName(parentUid: string, name: string): Promise<NodeEntity | null> {
        for await (const maybeNode of this.driveClient!.iterateFolderChildren(parentUid)) {
            const node = unwrapNode(maybeNode);
            if (node.name === name) return node;
        }
        return null;
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function unwrapNode(maybeNode: MaybeNode): NodeEntity {
    if ("ok" in maybeNode && !(maybeNode as { ok: boolean }).ok) {
        throw new Error(`[fsProtondrive] degraded node`);
    }
    return ("value" in maybeNode ? (maybeNode as { value: NodeEntity }).value : maybeNode) as NodeEntity;
}

function nodeToEntity(node: NodeEntity, key: string): Entity {
    const isFolder = node.type === NodeType.Folder;
    return {
        key: isFolder && !key.endsWith("/") ? `${key}/` : key,
        keyRaw: key,
        mtimeCli: node.activeRevision?.claimedModificationTime?.getTime()
            ?? node.modificationTime.getTime(),
        mtimeSvr: node.modificationTime.getTime(),
        size: node.activeRevision?.claimedSize ?? node.totalStorageSize ?? 0,
        synthesizedFolder: isFolder,
        etag: node.uid,
    };
}
