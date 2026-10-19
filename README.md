# Karaoke Signos

App web de karaoke por mesas para **Signos Rock & Band**.
Producción: https://karaokesignos.grupoleonia.com

| Ruta | Quién la usa |
|---|---|
| `/` | Clientes desde el celular (entran con el QR de la TV) |
| `/tv` | Pantalla del bar, en pantalla completa (requiere sesión de admin en ese computador) |
| `/admin` | Panel del administrador |

## Reglas implementadas

- **Cola por rondas:** una canción por mesa en cada ronda; las mesas nuevas entran al final de la rotación.
- **Código de la noche:** 4 caracteres que cambian cada noche y van en el QR de la TV. El admin puede renovarlo sin sacar a nadie.
- **Duplicados:** se bloquea la misma canción con el mismo artista, o el mismo video de YouTube.
- **Votos secretos:** un voto por mesa y por canción; la mesa que canta no vota. Solo el admin ve el puntaje.
- **Prioridad:** si una canción supera el umbral (por defecto 3 mesas y promedio ≥ 4,5), el admin decide si da una canción extra.
- **Límite por persona:** máximo 2 canciones en espera (ajustable).
- **Mesas:** el admin abre mesas, agrega canciones por quien no tenga celular y cierra la mesa cuando se levanta.
- **Cerrar la noche:** limpia mesas, cola, historial y votos, e invalida el código.

## Arquitectura

- **Cloudflare Worker** sirve los archivos de `public/` y enruta `/ws` y `/api/*`.
- **Durable Object `Room`** (SQLite) es la única fuente de verdad. Procesa las acciones en orden y reparte el estado por WebSocket con hibernación; el `ping` se responde sin despertar el objeto.
- **Reglas** en `src/logic.ts` (funciones puras, con pruebas en `test/logic.test.ts`).
- **Seguridad:** contraseña de admin con PBKDF2-SHA256 (100.000 iteraciones), cookie `HttpOnly; Secure; SameSite=Strict`, bloqueo de 10 min tras 5 intentos fallidos, sesiones de cliente firmadas con HMAC y atadas a la noche, verificación de origen en WebSocket, CSP estricta y límite de mensajes por conexión.
- **YouTube:** la TV usa el reproductor oficial (IFrame API, sin clave). El título de un link se obtiene con oEmbed público.

## Configuración (una sola vez)

En GitHub → Settings → Secrets and variables → Actions, crea:

| Secreto | Valor |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token de Cloudflare con: Account · Workers Scripts · Edit; Account · Account Settings · Read; Zone · Workers Routes · Edit; Zone · DNS · Edit; Zone · Zone · Read (zona `grupoleonia.com`) |
| `CLOUDFLARE_ACCOUNT_ID` | ID de la cuenta de Cloudflare |
| `ADMIN_USER` | Usuario del panel, p. ej. `admin` |
| `ADMIN_PASS_HASH` | Salida de `npm run hash-password -- "tu-contraseña"` (mínimo 10 caracteres) |
| `SESSION_SECRET` | Texto aleatorio largo, p. ej. salida de `openssl rand -base64 48` |

Cada push a `main` corre las pruebas y despliega. También se puede lanzar a mano en Actions → "Probar y desplegar" → Run workflow.

## Desarrollo local

```bash
npm install
npm run hash-password -- "clave-local-123"   # copia la salida
# crea .dev.vars con ADMIN_USER, ADMIN_PASS_HASH y SESSION_SECRET (no se sube a git)
npm run dev          # http://127.0.0.1:8787
npm test             # pruebas de reglas
node test/e2e.mjs    # prueba de punta a punta contra `npm run dev` (usa la clave prueba-local-123)
```

## Operación de una noche

1. En el computador del bar, entra a `/admin` e inicia sesión.
2. Pulsa **Abrir la noche** y luego **Abrir pantalla TV**. Lleva esa ventana al televisor y haz clic en "Toca para iniciar la pantalla" (activa sonido y pantalla completa).
3. La gente escanea el QR. Entre canciones la TV muestra el QR grande.
4. Para cada canción: **▶ Que empiece…** → la TV reproduce el video. Al terminar el video la TV vuelve sola al QR; si no hay video, pulsa **✓ Terminó**.
5. Si una canción no tiene video o YouTube no permite reproducirlo, usa **Elegir video** y pega el link.
6. Al final: **Cerrar la noche y limpiar el bar**.

## Pendiente (mejoras)

- Video intro con la voz en off sincronizada.
- Búsqueda de YouTube dentro del panel (requiere clave gratuita de la API; ~100 búsquedas/día).
