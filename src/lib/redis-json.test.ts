import { describe, it, expect } from 'vitest';
import { redisJson } from './ticket-lock';

describe('redisJson', () => {
  it('acepta el valor ya deserializado por @upstash/redis', () => {
    expect(redisJson<string[]>(['Ana', 'Beto'], [])).toEqual(['Ana', 'Beto']);
    expect(redisJson<{ start: number }>({ start: 9 }, { start: 8 })).toEqual({ start: 9 });
  });

  it('parsea el valor si llegó como texto JSON', () => {
    expect(redisJson<number[]>('[5,8]', [5])).toEqual([5, 8]);
  });

  it('devuelve el fallback si falta o es inválido', () => {
    expect(redisJson<number[]>(null, [5])).toEqual([5]);
    expect(redisJson<number[]>('', [5])).toEqual([5]);
    expect(redisJson<number[]>('no-es-json', [5])).toEqual([5]);
  });
});
