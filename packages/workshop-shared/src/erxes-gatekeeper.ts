// Erxes-gatekeeper extension for Executor catalog / connect RPCs.
// Workshop holds the GatekeeperUser stub and narrows it to call these methods.

import { GatekeeperUser } from "./gatekeeper.js";
import type {
  BeginExecutorConnectInput,
  BeginExecutorConnectResult,
  ExecutorIntegrationInfo,
  ExecutorIntegrationKind,
  IntegrationCatalogRow,
  SubmitExecutorSecretInput,
} from "./api.js";

export interface ErxesGatekeeperUser extends GatekeeperUser {
  listExecutorIntegrations(): Promise<ExecutorIntegrationInfo[]>;
  listIntegrationCatalog(query?: {
    q?: string;
    kind?: ExecutorIntegrationKind;
    limit?: number;
  }): Promise<IntegrationCatalogRow[]>;
  beginExecutorConnect(input: BeginExecutorConnectInput): Promise<BeginExecutorConnectResult>;
  submitExecutorSecret(input: SubmitExecutorSecretInput): Promise<{ slug: string }>;
  disconnectExecutorIntegration(slug: string): Promise<void>;
  reconnectExecutorIntegration(slug: string): Promise<BeginExecutorConnectResult>;
}
