import { describe, expect, it } from 'vitest';
import { parseJogStep, stepTooLarge } from './jogStep';

describe('custom jog step', () => {
  it('parses millimetres and inches into mm', () => {
    expect(parseJogStep('2.5', 'mm')).toEqual({ mm: 2.5 });
    expect(parseJogStep(' 37,5 ', 'mm')).toEqual({ mm: 37.5 });
    expect(parseJogStep('.5', 'mm')).toEqual({ mm: 0.5 });
    expect(parseJogStep('1', 'inch')).toEqual({ mm: 25.4 });
    expect(parseJogStep('0.00003', 'inch').error).toMatch(/Smallest/); // 0.00076 mm
  });

  it('rejects anything that is not a plain positive number', () => {
    for (const t of ['', '0', '-5', '1e3', 'abc', '5mm', '1.2.3', 'Infinity']) expect(parseJogStep(t, 'mm').error, t).toBeTruthy();
  });

  it('never sends a step longer than the travel of the axis it moves', () => {
    const env = { x: 400, y: 300, z: 80 };
    expect(stepTooLarge(100, [1, 0, 0], env)).toBeNull();
    expect(stepTooLarge(100, [0, 0, -1], env)).toMatch(/Z step 100 mm is larger than the Z travel \(80 mm\)/);
    expect(stepTooLarge(350, [0, 1, 0], env)).toMatch(/Y travel/);
    expect(stepTooLarge(400, [-1, 0, 0], env)).toBeNull();
  });
});
