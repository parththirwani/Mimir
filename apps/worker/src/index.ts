import { getConfig, getLogger, version } from "@mimir/backend-core";
import { scheduleConnectionCanary, scheduleDormancySweep, scheduleMailPollSweep, scheduleTriggerTick, scheduleWatchRenewal, startWorkers } from "./infra/queues.js";
import { startOutboxRelay } from "./infra/outbox-relay.js";
import { startWebhookRelay } from "./infra/webhook-relay.js";

getConfig();
startWorkers();
startOutboxRelay();
startWebhookRelay();
void scheduleDormancySweep().catch((e) => getLogger().error({ err: e }, "failed to schedule dormancy sweep"));
void scheduleMailPollSweep().catch((e) => getLogger().error({ err: e }, "failed to schedule mail poll sweep"));
void scheduleTriggerTick().catch((e) => getLogger().error({ err: e }, "failed to schedule trigger tick"));
void scheduleWatchRenewal().catch((e) => getLogger().error({ err: e }, "failed to schedule watch renewal"));
void scheduleConnectionCanary().catch((e) => getLogger().error({ err: e }, "failed to schedule connection canary"));

getLogger().info({ version }, "@mimir/worker ready");
