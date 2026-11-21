import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const site = "https://workout-five-vert.vercel.app";
const callback = site + "/api/photos";
const driveScope = "https://www.googleapis.com/auth/drive.appdata";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const userInfoUrl = "https://openidconnect.googleapis.com/v1/userinfo";
const driveFiles = "https://www.googleapis.com/drive/v3/files";
const driveUpload = "https://www.googleapis.com/upload/drive/v3/files";
const sessionCookie = "__Host-workout-photos";
const flowCookie = "__Host-workout-photo-login";
const sessionSeconds = 180 * 24 * 60 * 60;
const maxPhotoBytes = 1024 * 1024;
const validMachineId = /^[A-Za-z0-9_-]{1,128}$/;
const photoPrefix = "workout-machine-";

class PhotoError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}

function settings() {
  const clientId = process.env.WORKOUT_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.WORKOUT_GOOGLE_CLIENT_SECRET;
  const ownerEmail = process.env.WORKOUT_PHOTO_OWNER_EMAIL?.trim().toLowerCase();
  const key = Buffer.from(process.env.WORKOUT_PHOTO_SESSION_KEY || "", "base64url");
  if (!clientId || !clientSecret || !ownerEmail || key.length !== 32) {
    throw new PhotoError(503, "photo_sync_unconfigured");
  }
  return { clientId, clientSecret, ownerEmail, key };
}

function seal(key, purpose, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function open(key, purpose, value) {
  if (!value) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const json = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    const data = JSON.parse(json.toString("utf8"));
    return data.expires > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function readCookie(request, key) {
  const cookie = request.headers.get("cookie")?.split(/;\s*/).find(part => part.startsWith(key + "="));
  return cookie?.slice(key.length + 1);
}

function setCookie(headers, key, value, seconds) {
  headers.append("Set-Cookie", `${key}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`);
}

function headersForPhotos() {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Vercel-CDN-Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
}

function redirect(headers, location) {
  headers.set("Location", location);
  return new Response(null, { status: 303, headers });
}

async function getGoogleToken(config, grant) {
  const response = await fetch(googleTokenUrl, {
    method: "POST",
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...grant }),
    signal: AbortSignal.timeout(8000)
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new PhotoError(result.error === "invalid_grant" ? 401 : 502, "google_token_unavailable");
  }
  return result;
}

function beginLogin(config, headers) {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  setCookie(headers, flowCookie, seal(config.key, flowCookie, { state, verifier, expires: Date.now() + 600000 }), 600);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callback,
    response_type: "code",
    scope: `openid email ${driveScope}`,
    access_type: "offline",
    prompt: "consent",
    login_hint: config.ownerEmail,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256"
  });
  return redirect(headers, url);
}

async function completeLogin(request, url, config, headers) {
  const saved = open(config.key, flowCookie, readCookie(request, flowCookie));
  setCookie(headers, flowCookie, "", 0);
  const state = Buffer.from(url.searchParams.get("state") || "");
  const expected = Buffer.from(saved?.state || "");
  if (!saved || expected.length !== state.length || !timingSafeEqual(expected, state)) {
    return redirect(headers, site + "/?photoLogin=failed#machines");
  }
  if (url.searchParams.has("error")) return redirect(headers, site + "/?photoLogin=cancelled#machines");
  try {
    const tokens = await getGoogleToken(config, {
      grant_type: "authorization_code",
      code: url.searchParams.get("code") || "",
      code_verifier: saved.verifier,
      redirect_uri: callback
    });
    const userResponse = await fetch(userInfoUrl, {
      headers: { Authorization: "Bearer " + tokens.access_token },
      signal: AbortSignal.timeout(8000)
    });
    const user = await userResponse.json();
    if (!userResponse.ok || user.email_verified !== true || user.email?.toLowerCase() !== config.ownerEmail) {
      return redirect(headers, site + "/?photoLogin=account#machines");
    }
    if (!tokens.refresh_token || !tokens.scope?.split(" ").includes(driveScope)) {
      return redirect(headers, site + "/?photoLogin=failed#machines");
    }
    const session = {
      ownerEmail: config.ownerEmail,
      expires: Date.now() + sessionSeconds * 1000,
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      accessExpires: Date.now() + tokens.expires_in * 1000
    };
    setCookie(headers, sessionCookie, seal(config.key, sessionCookie, session), sessionSeconds);
    return redirect(headers, site + "/#machines");
  } catch {
    return redirect(headers, site + "/?photoLogin=failed#machines");
  }
}

async function photoAccessToken(request, config, headers) {
  const session = open(config.key, sessionCookie, readCookie(request, sessionCookie));
  if (!session || session.ownerEmail !== config.ownerEmail) throw new PhotoError(401, "sign_in_required");
  if (session.accessExpires > Date.now() + 60000) return session.access;
  try {
    const tokens = await getGoogleToken(config, { grant_type: "refresh_token", refresh_token: session.refresh });
    session.access = tokens.access_token;
    session.refresh = tokens.refresh_token || session.refresh;
    session.accessExpires = Date.now() + tokens.expires_in * 1000;
    session.expires = Date.now() + sessionSeconds * 1000;
    setCookie(headers, sessionCookie, seal(config.key, sessionCookie, session), sessionSeconds);
    return session.access;
  } catch (error) {
    if (error.status === 401) setCookie(headers, sessionCookie, "", 0);
    throw error;
  }
}

async function driveRequest(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: "Bearer " + token },
    redirect: "error",
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new PhotoError(502, "drive_unavailable");
  return response;
}

async function findPhotos(token, machineId) {
  const photos = [];
  let pageToken;
  do {
    const url = new URL(driveFiles);
    url.search = new URLSearchParams({
      spaces: "appDataFolder",
      q: machineId ? `name = '${photoPrefix}${machineId}.jpg'` : `name contains '${photoPrefix}'`,
      orderBy: "modifiedTime desc",
      pageSize: "100",
      fields: "nextPageToken,files(id,name,modifiedTime,appProperties)",
      ...(pageToken ? { pageToken } : {})
    });
    const result = await (await driveRequest(token, url)).json();
    photos.push(...result.files);
    pageToken = result.nextPageToken;
  } while (pageToken && !machineId);
  return photos;
}

function metadataFor(file) {
  return {
    machineId: file.name.slice(photoPrefix.length, -4),
    updated: file.modifiedTime,
    active: file.appProperties?.active !== "false"
  };
}

async function decodePhoto(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new PhotoError(415, "jpeg_required");
  }
  if (Number(request.headers.get("content-length")) > maxPhotoBytes * 4 / 3 + 64) {
    throw new PhotoError(413, "photo_too_large");
  }
  let body;
  try {
    body = await request.json();
  } catch {
    throw new PhotoError(400, "invalid_photo");
  }
  if (typeof body?.jpeg !== "string" || body.jpeg.length > Math.ceil(maxPhotoBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(body.jpeg)) {
    throw new PhotoError(400, "invalid_photo");
  }
  const bytes = Buffer.from(body.jpeg, "base64");
  if (bytes.length < 5 || bytes.length > maxPhotoBytes ||
      !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      !bytes.subarray(-2).equals(Buffer.from([255, 217]))) {
    throw new PhotoError(400, "invalid_photo");
  }
  return bytes;
}

async function uploadPhoto(token, machineId, existing, bytes) {
  const boundary = "workout-" + randomBytes(16).toString("hex");
  const metadata = {
    name: photoPrefix + machineId + ".jpg",
    appProperties: { active: "true" },
    ...(!existing ? { parents: ["appDataFolder"] } : {})
  };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const url = new URL(driveUpload + (existing ? "/" + encodeURIComponent(existing.id) : ""));
  url.search = new URLSearchParams({ uploadType: "multipart", fields: "name,modifiedTime,appProperties" });
  return (await driveRequest(token, url, {
    method: existing ? "PATCH" : "POST",
    headers: { "Content-Type": "multipart/related; boundary=" + boundary },
    body
  })).json();
}

async function hidePhoto(token, existing) {
  const url = new URL(driveFiles + "/" + encodeURIComponent(existing.id));
  url.searchParams.set("fields", "name,modifiedTime,appProperties");
  return (await driveRequest(token, url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appProperties: { active: "false" } })
  })).json();
}

async function handler(request) {
  const headers = headersForPhotos();
  try {
    const config = settings();
    const url = new URL(request.url);
    const action = url.searchParams.get("action");
    const method = request.method;
    if (!["GET", "PUT", "DELETE", "POST"].includes(method)) throw new PhotoError(405, "method_not_allowed");
    if (method !== "GET" && request.headers.get("origin") !== site) throw new PhotoError(403, "origin_denied");
    if (method === "GET" && action === "login") return beginLogin(config, headers);
    if (method === "GET" && (url.searchParams.has("code") || url.searchParams.has("error"))) {
      return await completeLogin(request, url, config, headers);
    }
    if (method === "POST" && action === "logout") {
      setCookie(headers, sessionCookie, "", 0);
      return Response.json({ signedIn: false }, { headers });
    }
    if (method === "POST") throw new PhotoError(405, "method_not_allowed");

    const machineId = url.searchParams.get("machine");
    if ((machineId !== null && !validMachineId.test(machineId)) || (method !== "GET" && !machineId)) {
      throw new PhotoError(400, "invalid_machine");
    }
    const token = await photoAccessToken(request, config, headers);
    const bytes = method === "PUT" ? await decodePhoto(request) : null;
    const files = await findPhotos(token, machineId);
    if (method === "GET" && !machineId) {
      const photos = new Map();
      for (const file of files) {
        const metadata = metadataFor(file);
        if (validMachineId.test(metadata.machineId) && !photos.has(metadata.machineId)) {
          photos.set(metadata.machineId, metadata);
        }
      }
      return Response.json({ signedIn: true, photos: [...photos.values()] }, { headers });
    }
    const existing = files[0];
    if (method === "PUT") {
      return Response.json(metadataFor(await uploadPhoto(token, machineId, existing, bytes)), { headers });
    }
    if (method === "DELETE") {
      const metadata = existing
        ? metadataFor(await hidePhoto(token, existing))
        : { machineId, active: false };
      return Response.json(metadata, { headers });
    }
    if (!existing || !metadataFor(existing).active) throw new PhotoError(404, "photo_not_found");
    const content = await driveRequest(token, driveFiles + "/" + encodeURIComponent(existing.id) + "?alt=media");
    headers.set("Content-Type", "image/jpeg");
    return new Response(content.body, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof PhotoError ? error.message : "photo_sync_unavailable" }, {
      status: error instanceof PhotoError ? error.status : 502, headers
    });
  }
}

export default { fetch: handler };
