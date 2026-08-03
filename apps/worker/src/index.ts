import { getConfig, getLogger, version } from "@mimir/backend-core";
import { startWorkers } from "./queues.js";

getConfig();
startWorkers();

getLogger().info({ version }, "@mimir/worker ready");
