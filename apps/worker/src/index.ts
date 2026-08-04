import { getConfig, getLogger, version } from "@mimir/backend-core";
import { scheduleDormancySweep, scheduleMailPollSweep, startWorkers } from "./queues.js";
import { startOutboxRelay } from "./outbox-relay.js";

getConfig();
startWorkers();
startOutboxRelay();
void scheduleDormancySweep().catch((e) => getLogger().error({ err: e }, "failed to schedule dormancy sweep"));
void scheduleMailPollSweep().catch((e) => getLogger().error({ err: e }, "failed to schedule mail poll sweep"));

getLogger().info({ version }, "@mimir/worker ready");
