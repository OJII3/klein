import { writeFile } from "node:fs/promises";

import { KleinConfigSchema } from "../src/app/config-schema.ts";

await writeFile("config/klein.schema.json", `${JSON.stringify(KleinConfigSchema, null, 2)}\n`);
