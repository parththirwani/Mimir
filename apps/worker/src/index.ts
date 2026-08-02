import { getConfig, version } from "@mimir/backend-core";

getConfig();

console.log(`@mimir/worker ready (backend-core v${version})`);
