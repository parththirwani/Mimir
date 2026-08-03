import { getConfig, getLogger, version } from "@mimir/backend-core";
import { scheduleDormancySweep, startWorkers } from "./queues.js";
import { startOutboxRelay } from "./outbox-relay.js";

getConfig();
startWorkers();
startOutboxRelay();
void scheduleDormancySweep().catch((e) => getLogger().error({ err: e }, "failed to schedule dormancy sweep"));

getLogger().info({ version }, "@mimir/worker ready");
