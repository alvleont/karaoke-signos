// Firmas HMAC para sesiones y verificación de contraseña PBKDF2 con WebCrypto.

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function sign(secret: string, data: string): Promise<string> {
  return b64u(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}
export async function verifySig(secret: string, data: string, sig: string): Promise<boolean> {
  try { return await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64(sig), enc.encode(data)); }
  catch { return false; }
}

// Sesión de cliente: userId.nightId.firma
export async function clientToken(secret: string, userId: string, nightId: string) {
  return `${userId}.${nightId}.${await sign(secret, `c.${userId}.${nightId}`)}`;
}
export async function readClientToken(secret: string, token: string | null) {
  const p = (token || '').split('.');
  if (p.length !== 3) return null;
  return (await verifySig(secret, `c.${p[0]}.${p[1]}`, p[2])) ? { userId: p[0], nightId: p[1] } : null;
}

// Sesión de admin: vencimiento.firma (en cookie HttpOnly)
export async function adminToken(secret: string, ttlMs: number, now: number) {
  const exp = String(now + ttlMs);
  return `${exp}.${await sign(secret, `a.${exp}`)}`;
}
export async function readAdminToken(secret: string, token: string | null, now: number) {
  const [exp, sig] = (token || '').split('.');
  if (!exp || !sig || Number(exp) < now) return false;
  return verifySig(secret, `a.${exp}`, sig);
}

// Formato: pbkdf2_sha256$iteraciones$salt_b64url$hash_b64url
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [algo, it, salt, hash] = (stored || '').split('$');
  if (algo !== 'pbkdf2_sha256' || !it || !salt || !hash) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations: Number(it) }, key, 256);
  return timingSafeEqual(new Uint8Array(bits), fromB64(hash));
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}
export function getCookie(req: Request, name: string): string | null {
  const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
