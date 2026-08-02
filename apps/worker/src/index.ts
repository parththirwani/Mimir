import { getConfig, getLogger, version } from "@mimir/backend-core";

getConfig();

getLogger().info({ version }, "@mimir/worker ready");
