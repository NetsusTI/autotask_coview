import { describe, it, expect } from 'vitest';
import { readNameFrom } from './identity';

// Import relativo a propósito: el alias '@' apunta a src/ en vitest.config.ts (el
// backend) y a ticket_lock_wxt/ en WXT. Usar './identity' evita esa colisión.

describe('readNameFrom', () => {
  it('prefiere narrativeFullName cuando está presente', () => {
    expect(readNameFrom({ narrativeFullName: 'Ricardo Illanes' })).toBe('Ricardo Illanes');
  });

  it('recorta espacios sobrantes y colapsa los internos', () => {
    expect(readNameFrom({ narrativeFullName: '  Marelis   Peña  ' })).toBe('Marelis Peña');
  });

  it('cae a firstName + lastName si narrativeFullName no sirve', () => {
    expect(readNameFrom({ narrativeFullName: '   ', firstName: 'Tomas', lastName: 'Santander' }))
      .toBe('Tomas Santander');
  });

  it('acepta tildes, ñ y apellidos compuestos', () => {
    expect(readNameFrom({ narrativeFullName: 'Nicolás Segarra Peña' })).toBe('Nicolás Segarra Peña');
    expect(readNameFrom({ firstName: 'María José', lastName: "O'Brien-Fariñez" }))
      .toBe("María José O'Brien-Fariñez");
  });

  it('exige nombre Y apellido en el fallback (solo firstName no alcanza)', () => {
    expect(readNameFrom({ firstName: 'Cesar' })).toBeNull();
    expect(readNameFrom({ lastName: 'Palma' })).toBeNull();
  });

  // Estas son las formas que rompieron la detección en producción: el objeto existe
  // pero no trae el nombre donde lo esperábamos.
  it('devuelve null si el objeto no trae ningún campo reconocible', () => {
    expect(readNameFrom({ userId: 123, companyName: 'Netsus' })).toBeNull();
    expect(readNameFrom({})).toBeNull();
  });

  it('devuelve null para entradas que no son objetos', () => {
    expect(readNameFrom(undefined)).toBeNull();
    expect(readNameFrom(null)).toBeNull();
    expect(readNameFrom('Ricardo Illanes')).toBeNull();
    expect(readNameFrom(42)).toBeNull();
  });

  it('ignora campos que no son strings', () => {
    expect(readNameFrom({ narrativeFullName: { toString: () => 'X' } })).toBeNull();
    expect(readNameFrom({ firstName: 1, lastName: 2 })).toBeNull();
  });

  it('nunca lanza aunque la página exponga un getter hostil', () => {
    const hostil = {
      get narrativeFullName(): string { throw new Error('boom'); },
    };
    expect(() => readNameFrom(hostil)).not.toThrow();
    expect(readNameFrom(hostil)).toBeNull();
  });

  // El valor termina en un data-attribute del DOM y viaja al servidor como identidad.
  // No es la frontera de seguridad (eso es sanitizeUser()), pero no tiene sentido
  // propagar algo que evidentemente no es un nombre.
  it('rechaza valores que claramente no son un nombre', () => {
    expect(readNameFrom({ narrativeFullName: '<img src=x onerror=alert(1)>' })).toBeNull();
    expect(readNameFrom({ narrativeFullName: '{"user":"admin"}' })).toBeNull();
    expect(readNameFrom({ narrativeFullName: 'a'.repeat(61) })).toBeNull();
  });

  it('acepta un nombre de exactamente 60 caracteres, el tope del servidor', () => {
    const justo = 'a'.repeat(60);
    expect(readNameFrom({ narrativeFullName: justo })).toBe(justo);
  });
});
