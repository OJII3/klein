import { writeFile } from "node:fs/promises";

import { ConfigSchema } from "../src/app/config-schema.ts";

await writeFile("config/config.schema.json", `${JSON.stringify(ConfigSchema, null, 2)}\n`);
