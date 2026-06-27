// Shared, localStorage-backed settings used by the game and the Settings page.

export const LEVELS = {
  fast:   { label: 'Fast',   timeMs: 100 },
  medium: { label: 'Medium', timeMs: 600 },
  strong: { label: 'Strong', timeMs: 2000 },
  max:    { label: 'Max',    timeMs: 5000 },
};

const KEY = 'othello-settings';

const DEFAULTS = {
  color: 'black',   // 'black' | 'white' | 'random'  (the human's color)
  level: 'medium',  // key into LEVELS
  showHints: true,
  animate: true,
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, ...settings }));
}

export function levelMs(level) {
  return (LEVELS[level] || LEVELS.medium).timeMs;
}

/** Resolve 'random' to a concrete color for a new game. */
export function resolveColor(color) {
  if (color === 'random') return Math.random() < 0.5 ? 'black' : 'white';
  return color;
}
