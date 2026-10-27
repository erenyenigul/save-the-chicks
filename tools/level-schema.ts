// Writes src/world/levels/level.schema.json from the zod schema, so editors can
// autocomplete and validate level files.
//
//   npm run level-schema
import fs from 'node:fs';
import { z } from 'zod';
import { levelSchema } from '../src/world/levelSchema.ts';

const out = new URL('../src/world/levels/level.schema.json', import.meta.url);
const schema = z.toJSONSchema(levelSchema, { io: 'input' });
fs.writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
