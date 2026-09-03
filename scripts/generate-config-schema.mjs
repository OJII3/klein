import { writeFile } from "node:fs/promises";

import { KleinConfigSchema } from "../dist/app/config-schema.js";

await writeFile("config/klein.schema.json", `${JSON.stringify(KleinConfigSchema, null, 2)}\n`);
