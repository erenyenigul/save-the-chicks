import { z } from 'zod';

const MAP_LEGEND = `Top-down tile map, one string per row (row 0 is the north/top wall).
  #  wall            .  floor           X  exit (on the outer wall; the street goes outside it)
  P  player start    L  emergency stop: button on the adjacent north, east or west wall
  H  hopper; a belt starts next to it and runs (> < ^ v) into a grinder G
  S  sorter: splits the belt, males to a grinder G, females on to an egg farm F
  B  large crate (blocks sight)          b  small crate (low, see-through)
  T  storage tank    R  robot arm        c  traffic cone
The production line must be at least 12 walking steps from every exit.`;

/** A tile as [col, row] in the file; { col, row } in the game. */
const cell = z
  .tuple([z.int().nonnegative(), z.int().nonnegative()])
  .transform(([col, row]) => ({ col, row }));

const seconds = z.number().positive();

/** Shape of a level file in src/world/levels/. Map semantics are checked later by parseLevel. */
export const levelSchema = z.strictObject({
  $schema: z.string().optional(),
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .describe('Stable key for saved progress. Never change it once the level has been released.'),
  name: z.string().min(1),
  map: z.array(z.string().min(3)).min(3).describe(MAP_LEGEND),
  guards: z
    .array(z.array(cell).min(1))
    .describe('One patrol route per guard: walkable [col, row] tiles visited in order, looping.'),
  rules: z.strictObject({
    parSeconds: seconds.describe('Finishing faster than this earns a time bonus.'),
    totalChicks: z.int().positive().describe('Chicks the hoppers drop over the whole level.'),
    chicksToSave: z.int().positive().describe('Chicks that must reach an exit to win.'),
    maxLost: z.int().positive().describe('The level is lost once this many chicks are ground up or caged.'),
    beltSpeed: z.number().positive().describe('Belt speed in tiles per second.'),
    spawnInterval: z
      .strictObject({ start: seconds, end: seconds })
      .describe('Seconds between drops at the start and at the end of the level.'),
  }),
});

export type LevelDefinition = z.output<typeof levelSchema>;
export type LevelRules = LevelDefinition['rules'];
