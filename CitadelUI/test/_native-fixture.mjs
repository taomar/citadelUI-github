import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { BrowserDirectoryProvider } from '../web/js/directory-provider.mjs';
import { createTransactionCommit } from '../web/js/transaction-client.mjs';
import { LocalTransactionCoordinator } from '../web/js/mutation-coordinator.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';
import { TransactionStore } from '../server/transactions.mjs';
import { LocalDirectory } from './_local-directory-fixture.mjs';

// Synthetic native roots with the pinned repository's signatures and native
// key/type shapes. No upstream examples are silently treated as live inputs.
export const NATIVE_FILES = Object.freeze({
  'variables.tf': `variable "environment_name" { type = string }
variable "location" { type = string }
variable "apim_sku" { type = string }
variable "enabled" { type = bool }
variable "ratio" { type = number }
variable "ai_foundry_models" {
  type = list(object({ name = string, capacity = optional(number, 100) }))
}
variable "optional_note" { type = string
  default = null
}
variable "number_list" { type = list(number)
  default = []
}
variable "pair" { type = tuple([string, number])
  default = ["", 0]
}
variable "optional_object" { type = object({ label = string, tags = map(string) })
  default = null
}
`,
  'main.tf': `locals {
  inputs = [var.environment_name, var.location, var.apim_sku, var.enabled, var.ratio, var.ai_foundry_models]
}
`,
  'environments/development.tfvars': `# SYNTHETIC DEVELOPMENT
environment_name = "synthetic-dev" # keep this comment
location = "westeurope"
apim_sku = "Developer"
enabled = true
ratio = 0.12345678901234567890123456789
ai_foundry_models = [{ name = "model-a", capacity = 100 }]
`,
  'llm-backend-onboarding/variables.tf': `variable "apim_name" { type = string }
variable "managed_identity_client_id" { type = string }
variable "llm_backend_config" {
  type = list(object({
    backend_id = string
    backend_type = string
    endpoint = string
    auth_scheme = optional(string)
    auth_type = optional(string)
    auth_config = optional(object({ named_value_key = optional(string), key_vault_secret_uri = optional(string), secret_value = optional(string) }))
    priority = optional(number, 1)
    weight = optional(number, 100)
    supported_models = list(object({ name = string, sku = optional(string, "Standard"), capacity = optional(number, 100), modelFormat = optional(string, "OpenAI"), modelVersion = optional(string, "1"), apiVersion = optional(string), timeout = optional(number, 120) }))
  }))
}
variable "configure_circuit_breaker" { type = bool
  default = true
}
`,
  'llm-backend-onboarding/main.tf': `locals {
  inputs = [var.apim_name, var.managed_identity_client_id, var.llm_backend_config]
}
`,
  'llm-backend-onboarding/operator.tfvars': `# SYNTHETIC LLM INPUTS
apim_name = "synthetic-gateway"
managed_identity_client_id = ""
llm_backend_config = [{
  backend_id = "synthetic-backend"
  backend_type = "azure-openai"
  endpoint = "https://synthetic.invalid"
  auth_config = { named_value_key = "key-name", secret_value = null }
  priority = 1
  supported_models = [{ name = "model-a", capacity = 100, modelFormat = "OpenAI", modelVersion = "1", sku = "Standard" }]
}]
`,
  'citadel-access-contracts/variables.tf': `variable "apim" { type = object({ subscription_id = string, resource_group_name = string, name = string }) }
variable "use_case" { type = object({ business_unit = string, use_case_name = string, environment = string }) }
variable "api_name_mapping" { type = map(list(string)) }
variable "services" { type = list(object({ code = string, endpoint_secret_name = string, api_key_secret_name = string, policy_xml = optional(string, "") })) }
variable "product_terms" { type = string
  default = ""
}
`,
  'citadel-access-contracts/main.tf': `locals {
  inputs = [var.apim, var.use_case, var.api_name_mapping, var.services]
  default_policy = file("\${path.module}/policies/default-ai-product-policy.xml")
}
`,
  'citadel-access-contracts/operator.tfvars': `# SYNTHETIC ACCESS INPUTS (not the malformed upstream example)
apim = { subscription_id = "", resource_group_name = "synthetic-rg", name = "synthetic-gateway" }
use_case = { business_unit = "demo", use_case_name = "alpha", environment = "dev" }
api_name_mapping = { demo = ["chat"] }
services = [{
  code = "chat"
  endpoint_secret_name = "endpoint-name"
  api_key_secret_name = "key-name"
  policy_xml = "<policies><inbound><base /></inbound></policies>"
}]
`,
  'citadel-access-contracts/policies/default-ai-product-policy.xml': '<policies><inbound><base /></inbound></policies>\n',
});

export function nativeConfiguration(units = ['deployment', 'llm', 'access']) {
  const paths = { deployment: 'environments/development.tfvars', llm: 'llm-backend-onboarding/operator.tfvars', access: 'citadel-access-contracts/operator.tfvars' };
  const roots = { deployment: '', llm: 'llm-backend-onboarding', access: 'citadel-access-contracts' };
  return createConfiguration('terraform', units.map((selection) => {
    const unit = typeof selection === 'string' ? { area: selection } : selection;
    return { rootAlias: roots[unit.area], valueAlias: paths[unit.area], syntax: 'hcl-tfvars', allowCreate: false, nonsecret: true, ...unit };
  }));
}

export function nativeDirectory(files = NATIVE_FILES) {
  const root = new LocalDirectory('synthetic-native');
  for (const [alias, text] of Object.entries(files)) root.put(alias, text);
  function bind(directory) {
    directory.removeEntry = async function (name) {
      await this.event('removeEntry', name);
      const entry = this.children.get(name);
      if (!entry) throw new DOMException('Missing entry', 'NotFoundError');
      if (entry.kind === 'directory' && entry.children.size) throw new DOMException('Not empty', 'InvalidModificationError');
      this.children.delete(name);
    };
    directory.resolve = async function (target) {
      if (target === this) return [];
      for (const [name, child] of this.children) {
        if (target === child) return [name];
        if (child.kind === 'directory') { const rest = await child.resolve(target); if (rest !== null) return [name, ...rest]; }
      }
      return null;
    };
    const getDirectory = directory.getDirectoryHandle.bind(directory);
    directory.getDirectoryHandle = async (...args) => {
      const child = await getDirectory(...args);
      if (!child.resolve) bind(child);
      return child;
    };
    for (const child of directory.children.values()) if (child.kind === 'directory') bind(child);
  }
  bind(root);
  return root;
}

export async function nativeLocalFixture(options = {}) {
  const configuration = options.configuration || nativeConfiguration();
  const root = nativeDirectory(options.onlyFiles || { ...NATIVE_FILES, ...options.files });
  root.owner.allowDefaultWritable = configuration.format === 'bicep';
  for (const alias of options.absent || []) {
    const parts = alias.split('/'), name = parts.pop();
    let parent = root;
    for (const part of parts) parent = await parent.getDirectoryHandle(part);
    await parent.removeEntry(name);
  }
  const provider = new BrowserDirectoryProvider(root, { configuration });
  const environment = { id: options.environmentId || 'native-local', projectId: 'synthetic-project', label: 'Native local', configuration,
    source: { kind: 'local', folderName: root.name, localPath: root.name } };
  const context = { projectId: environment.projectId, environment, provider, handle: root };
  const environments = new Map([[environment.id, environment]]);
  const dataRoot = await mkdtemp(join(tmpdir(), 'citadel-native-transaction-'));
  const store = new TransactionStore({ dataRoot, getEnvironment: async (id) => environments.get(id) });
  await store.initialize();
  const trace = [], hooks = {};
  const request = async (input, init = {}) => {
    const url = new URL(input, 'http://native-fixture.invalid'), parts = url.pathname.split('/').filter(Boolean);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const headers = init.headers || {};
    const env = headers['X-Citadel-Environment'] || url.searchParams.get('environmentId') || environment.id;
    const id = parts[2], action = parts[3], token = headers['X-Citadel-Transaction'];
    trace.push({ action: action || parts.at(-1), method: init.method || 'GET' });
    await hooks.request?.(url.pathname, init);
    if (id === 'prepare') return store.prepare(body);
    if (!id) return { transactions: await store.history(env) };
    if (!action) return { transaction: await store.getTransaction(env, id) };
    if (action === 'backups') {
      if (init.method === 'PUT') return store.uploadBackup(env, id, parts[4], token, headers['X-Citadel-Content-SHA256'], body);
      return headers['X-Citadel-Backup-Read']
        ? store.getBackupForRestore(env, id, parts[4], headers['X-Citadel-Backup-Read'])
        : store.getBackup(env, id, parts[4], token);
    }
    if (action === 'authorize') return store.authorize(env, id, token);
    if (action === 'committing') return store.beginCommit(env, id, headers['X-Citadel-Authorization'], body);
    if (action === 'receipt') return store.commitReceipt(env, id, headers['X-Citadel-Authorization'], body);
    if (action === 'fail') return store.fail(env, id, token, body);
    if (action === 'rollback') return store.rollback(env, id, token, body);
    if (action === 'revert') return store.beginRevert(env, id);
    if (action === 'recover') return store.recover(env, id);
    if (action === 'restore-token') return store.issueRestoreToken(env, id);
    throw new Error(`Unexpected native fixture API action: ${action}`);
  };
  const coordinator = new LocalTransactionCoordinator({ request, commitFiles: createTransactionCommit(request), contextProvider: () => context });
  const service = new WorkspaceService({ request, coordinator, contextProvider: () => context });
  return { root, provider, environment, context, configuration, environments, dataRoot, store, request, coordinator, service, trace, hooks,
    close: () => rm(dataRoot, { recursive: true, force: true }) };
}
