import { describe, it, expect, beforeEach } from 'vitest';
import * as L from '../src/logic';

let s: L.State;
let t = 1000;
const now = () => (t += 1000);
const join = (name: string, table: number) => L.join(s, { code: 'ABCD', name, table }, now());
const req = (u: L.User, title: string, artist = 'X') => L.requestSong(s, u.id, { title, artist }, now());

beforeEach(() => { s = L.newState(10); t = 1000; L.openNight(s, 'ABCD', 'n1', now()); });

describe('entrada', () => {
  it('exige el código de la noche', () => {
    expect(() => L.join(s, { code: 'ZZZZ', name: 'Ana', table: 1 }, now())).toThrow(L.UserError);
    expect(join('Ana', 1).table).toBe(1);
  });
  it('acepta el código en minúsculas y limpia el nombre', () => {
    const u = L.join(s, { code: 'abcd', name: '  Ana\n  María  ', table: 2 }, now());
    expect(u.name).toBe('Ana María');
  });
  it('rechaza si la noche está cerrada', () => {
    L.closeNight(s);
    expect(() => join('Ana', 1)).toThrow(/no ha abierto/);
  });
});

describe('cola por rondas', () => {
  it('una canción por mesa por ronda, en orden de llegada de mesas', () => {
    const a = join('A', 4), b = join('B', 2), c = join('C', 7);
    req(a, 'a1'); req(a, 'a2'); req(b, 'b1'); req(c, 'c1');
    expect(L.queue(s).map(q => q.song.title)).toEqual(['a1', 'b1', 'c1', 'a2']);
    expect(L.queue(s).map(q => q.round)).toEqual([1, 1, 1, 2]);
  });
  it('la mesa nueva entra al final de la rotación', () => {
    const a = join('A', 4), b = join('B', 2);
    req(a, 'a1'); req(a, 'a2'); req(b, 'b1');
    L.start(s, now()); // canta a1
    const c = join('C', 9); req(c, 'c1');
    expect(L.queue(s).map(q => q.song.title)).toEqual(['b1', 'c1', 'a2']);
  });
  it('rota después de la última mesa que cantó', () => {
    const a = join('A', 1), b = join('B', 2);
    req(a, 'a1'); req(b, 'b1'); req(a, 'a2'); req(b, 'b2');
    L.start(s, now()); L.finish(s, false, now());
    L.start(s, now()); L.finish(s, false, now());
    expect(L.queue(s).map(q => q.song.title)).toEqual(['a2', 'b2']);
  });
  it('la prioridad va primero y no altera la rotación', () => {
    const a = join('A', 1), b = join('B', 2);
    req(a, 'a1'); const b1 = req(b, 'b1');
    L.prioritizeSong(s, b1.id);
    expect(L.queue(s)[0].song.title).toBe('b1');
    L.start(s, now());
    expect(s.lastTable).toBeNull();
  });
  it('no deja empezar si alguien está cantando', () => {
    const a = join('A', 1); req(a, 'a1'); req(a, 'a2');
    L.start(s, now());
    expect(() => L.start(s, now())).toThrow(/terminó/);
  });
  it('ignora un "terminó" viejo de la TV', () => {
    const a = join('A', 1); req(a, 'a1');
    L.start(s, now());
    expect(L.finish(s, false, now(), 'otro-id')).toBe(false);
    expect(s.currentId).not.toBeNull();
  });
});

describe('duplicados y límites', () => {
  it('bloquea misma canción y artista, aunque cambien tildes y mayúsculas', () => {
    const a = join('A', 1), b = join('B', 2);
    req(a, 'Amor eterno', 'Rocío Dúrcal');
    expect(() => req(b, 'amor  ETERNO', 'rocio durcal')).toThrow(/ya/);
  });
  it('permite el mismo título de otro artista', () => {
    const a = join('A', 1), b = join('B', 2);
    req(a, 'Amor eterno', 'Rocío Dúrcal');
    expect(() => req(b, 'Amor eterno', 'Otro')).not.toThrow();
  });
  it('bloquea el mismo video de YouTube aunque el link sea distinto', () => {
    const a = join('A', 1), b = join('B', 2);
    L.requestSong(s, a.id, { url: 'https://youtu.be/dQw4w9WgXcQ' }, now());
    expect(() => L.requestSong(s, b.id, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3' }, now())).toThrow();
  });
  it('rechaza links que no son de YouTube', () => {
    const a = join('A', 1);
    expect(() => L.requestSong(s, a.id, { url: 'https://evil.com/?v=dQw4w9WgXcQx' }, now())).toThrow(/YouTube/);
  });
  it('limita las canciones en espera por persona', () => {
    const a = join('A', 1);
    req(a, 'uno'); req(a, 'dos');
    expect(() => req(a, 'tres')).toThrow(/máximo/);
  });
});

describe('mesas', () => {
  it('cerrar mesa cancela sus pendientes y saca a su gente', () => {
    const a = join('A', 3); req(a, 'a1');
    const kicked = L.closeTable(s, 3);
    expect(kicked).toEqual([a.id]);
    expect(L.queue(s)).toHaveLength(0);
    expect(() => req(a, 'a2')).toThrow(/sesión/);
  });
  it('el admin puede abrir una mesa y cantar por alguien sin celular', () => {
    const song = L.adminAddSong(s, { table: 5, name: 'Don Jorge', title: 'El rey', artist: 'Vicente' }, now());
    expect(L.T(s, 5)!.active).toBe(true);
    expect(L.queue(s)[0].song.id).toBe(song.id);
  });
  it('cerrar la noche limpia todo', () => {
    const a = join('A', 1); req(a, 'a1');
    L.closeNight(s);
    expect(s.songs).toHaveLength(0);
    expect(s.tables.every(x => !x.active)).toBe(true);
    expect(s.night).toBeNull();
  });
});

describe('votos', () => {
  it('un voto por mesa y la mesa que canta no vota', () => {
    const a = join('A', 1), b = join('B', 2), b2 = join('B2', 2);
    req(a, 'a1'); L.start(s, now());
    expect(() => L.vote(s, a.id, 5)).toThrow(/sí misma/);
    L.vote(s, b.id, 5);
    expect(() => L.vote(s, b2.id, 4)).toThrow(/ya votó/);
    expect(L.stats(s, s.currentId!)).toEqual({ count: 1, avg: 5 });
  });
  it('genera alerta al superar el umbral y la prioridad aplica al siguiente pedido', () => {
    s.settings.minVotes = 2;
    const a = join('A', 1), b = join('B', 2), c = join('C', 3);
    req(a, 'a1'); L.start(s, now());
    L.vote(s, b.id, 5);
    const r = L.vote(s, c.id, 5);
    expect(r.alert).toBeTruthy();
    L.resolveAlert(s, r.alert!.id, true);
    L.finish(s, false, now());
    const next = req(a, 'a2');
    expect(next.priority).toBe(true);
  });
  it('la vista del cliente no expone puntajes', () => {
    const a = join('A', 1), b = join('B', 2);
    req(a, 'a1'); L.start(s, now()); L.vote(s, b.id, 5);
    const v = JSON.stringify(L.clientView(s, b.id));
    expect(v).not.toMatch(/avg|"v":5|stats/);
    expect(JSON.stringify(L.clientView(s, b.id))).not.toContain('ABCD');
  });
});

describe('utilidades', () => {
  it('extrae el ID de YouTube de varios formatos', () => {
    expect(L.ytId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(L.ytId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x')).toBe('dQw4w9WgXcQ');
    expect(L.ytId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(L.ytId('hola')).toBeNull();
  });
  it('genera códigos de 4 caracteres sin letras confusas', () => {
    const c = L.genCode(n => Math.floor(Math.random() * n));
    expect(c).toMatch(/^[ACDEFGHJKMNPQRTUVWXY34679]{4}$/);
  });
});
