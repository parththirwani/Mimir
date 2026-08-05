import { getConfig, getLogger, version } from "@mimir/backend-core";
import { scheduleDormancySweep, scheduleMailPollSweep, scheduleTriggerTick, startWorkers } from "./infra/queues.js";
import { startOutboxRelay } from "./infra/outbox-relay.js";

getConfig();
startWorkers();
startOutboxRelay();
void scheduleDormancySweep().catch((e) => getLogger().error({ err: e }, "failed to schedule dormancy sweep"));
void scheduleMailPollSweep().catch((e) => getLogger().error({ err: e }, "failed to schedule mail poll sweep"));
void scheduleTriggerTick().catch((e) => getLogger().error({ err: e }, "failed to schedule trigger tick"));

getLogger().info({ version }, "@mimir/worker ready");
