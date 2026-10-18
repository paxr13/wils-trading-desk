// New and full moon times from Meeus, Astronomical Algorithms ch. 49.
// The main periodic terms keep the error to a few minutes, which is far finer than a 4H candle.

export interface MoonPhase {
  t: number; // unix seconds
  full: boolean;
}

const RAD = Math.PI / 180;

function phaseTime(k: number, full: boolean): number {
  const T = k / 1236.85;
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;
  let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.00000015 * T3 + 0.00000000073 * T4;
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const M = (2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3) * RAD;
  const Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4) * RAD;
  const F = (160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4) * RAD;
  const O = (124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3) * RAD;
  const s = Math.sin;
  const c = full
    ? [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515, 0.00209]
    : [-0.4072, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208];
  jde +=
    c[0] * s(Mp) +
    c[1] * E * s(M) +
    c[2] * s(2 * Mp) +
    c[3] * s(2 * F) +
    c[4] * E * s(Mp - M) +
    c[5] * E * s(Mp + M) +
    c[6] * E * E * s(2 * M) -
    0.00111 * s(Mp - 2 * F) -
    0.00057 * s(Mp + 2 * F) +
    0.00056 * E * s(2 * Mp + M) -
    0.00042 * s(3 * Mp) +
    0.00042 * E * s(M + 2 * F) +
    0.00038 * E * s(M - 2 * F) -
    0.00024 * E * s(2 * Mp - M) -
    0.00017 * s(O);
  // JDE is in Terrestrial Time; ~69 s ahead of UTC in the 2020s.
  return Math.round((jde - 2440587.5) * 86400 - 69);
}

/** All new and full moons between two unix times, in order. */
export function moonPhases(from: number, to: number): MoonPhase[] {
  const out: MoonPhase[] = [];
  const year = 1970 + from / 31556952;
  let k = Math.floor((year - 2000) * 12.3685) - 1;
  for (let guard = 0; guard < 5000; guard++, k++) {
    const tn = phaseTime(k, false);
    if (tn > to) break;
    if (tn >= from) out.push({ t: tn, full: false });
    const tf = phaseTime(k + 0.5, true);
    if (tf > to) break;
    if (tf >= from) out.push({ t: tf, full: true });
  }
  return out;
}
