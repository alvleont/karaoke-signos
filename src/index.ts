// Worker de entrada: /ws y /api/* van al Durable Object; el resto son archivos estáticos.
import { Room, type Env } from './room';
export { Room };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws' || url.pathname.startsWith('/api/')) {
      if (!env.SESSION_SECRET || !env.ADMIN_PASS_HASH || !env.ADMIN_USER)
        return new Response('Faltan secretos de configuración (ver README).', { status: 500 });
      const stub = env.ROOM.get(env.ROOM.idFromName('signos'));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
