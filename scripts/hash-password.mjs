// Uso: npm run hash-password -- "tu-contraseña"
// Imprime el valor para el secreto ADMIN_PASS_HASH (PBKDF2-SHA256, 100.000 iteraciones).
import { webcrypto as crypto } from 'node:crypto';
const pass = process.argv[2];
if (!pass || pass.length < 10) { console.error('Usa una contraseña de al menos 10 caracteres.'); process.exit(1); }
const b64u = b => Buffer.from(b).toString('base64url');
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
console.log(`pbkdf2_sha256$100000$${b64u(salt)}$${b64u(bits)}`);
