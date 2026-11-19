// Simulated HealthKit. The demo runs as a web app (PWA), which cannot read
// Apple Health, so values a phone would read from Health are simulated here
// with realistic ranges. Each value is marked "Health (simulated)".

export const SIMULATED_DEVICE = 'Health (simulated)';

export interface Simulation {
  unit: string;
  min: number;
  max: number;
  decimals: number;
}

const RULES: [RegExp, Simulation][] = [
  [/glu[ck]os|blood ?sugar|blodsocker|cgm/i, { unit: 'mmol/L', min: 5.2, max: 7.6, decimals: 1 }],
  [/heart ?rate|pulse|puls/i, { unit: '/min', min: 58, max: 78, decimals: 0 }],
  [/sleep|sömn/i, { unit: 'h', min: 6.3, max: 8.1, decimals: 1 }],
  [/steps|steg/i, { unit: 'steps', min: 4000, max: 11000, decimals: 0 }],
  [/peak.?flow|\bpef\b/i, { unit: 'L/min', min: 390, max: 470, decimals: 0 }],
  [/fev1/i, { unit: 'L', min: 2.7, max: 3.3, decimals: 2 }],
  [/spo2|oxygen|syremättnad/i, { unit: '%', min: 95, max: 99, decimals: 0 }],
  [/systol/i, { unit: 'mmHg', min: 116, max: 138, decimals: 0 }],
  [/diastol/i, { unit: 'mmHg', min: 72, max: 88, decimals: 0 }],
  [/weight|vikt/i, { unit: 'kg', min: 71, max: 73, decimals: 1 }],
];

/** The simulation for a measurement, if Health would have it. */
export function simulationFor(name: string): Simulation | undefined {
  return RULES.find(([pattern]) => pattern.test(name))?.[1];
}

/** A value in the range, stable for the same seed. */
export function simulate(simulation: Simulation, seed: number): string {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  const fraction = x - Math.floor(x);
  return (simulation.min + fraction * (simulation.max - simulation.min)).toFixed(simulation.decimals);
}

/** A rating from 0 to 10 rather than a measured value. */
export function isRating(name: string, rangeMin?: number, rangeMax?: number) {
  return /0\s*[–-]\s*10|rating|skatt/i.test(name) || (rangeMin === 0 && rangeMax === 10);
}
