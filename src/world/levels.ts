import { z } from 'zod';
import { parseLevel } from './LevelLayout';
import { levelSchema, type LevelDefinition } from './levelSchema';

export type { LevelDefinition, LevelRules } from './levelSchema';

/**
 * Every JSON file in ./levels, bundled at build time and played in filename
 * order (01-…, 02-…). To add a level, drop in a new numbered file.
 */
const files = import.meta.glob<unknown>('./levels/*.json', { eager: true, import: 'default' });

/**
 * Validates and returns all levels: the file shape first, then each map's rules
 * (connected belts, reachable guard routes, distance from exits). Throws a
 * readable error naming the bad file.
 */
export function loadLevels(): readonly LevelDefinition[] {
  const levels = Object.entries(files)
    .filter(([path]) => !path.endsWith('.schema.json'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, data]) => {
      const result = levelSchema.safeParse(data);
      if (!result.success) throw new Error(`Level file ${path} is invalid:\n${z.prettifyError(result.error)}`);
      parseLevel(result.data);
      return result.data;
    });

  const duplicate = levels.find((level, i) => levels.findIndex((other) => other.id === level.id) !== i);
  if (duplicate) throw new Error(`Two level files share the id "${duplicate.id}"`);
  return levels;
}
