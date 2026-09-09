ai_foundry_external_access = false

ai_foundry_instances = [
  {
    "custom_subdomain" = "foundry-export-demo"
    "default_project_name" = "export-project"
    "location" = "eastus2"
    "name" = "foundry-export-demo"
    "network_injection_enabled" = false
  },
]

ai_foundry_models = [
  {
    "ai_service_index" = 0
    "capacity" = 100
    "name" = "gpt-4.1"
    "publisher" = "OpenAI"
    "sku" = "GlobalStandard"
    "version" = "2025-04-14"
  },
]

apim_log_body_bytes = 8192

apim_log_verbosity = "information"

apim_network_type = "Internal"

apim_publisher_email = "operator@example.invalid"

apim_publisher_name = "Synthetic export"

apim_service_name = "apim-export-demo"

apim_sku = "Developer"

apim_sku_units = 1

apim_subnet_name = "snet-apim"

azure_login_endpoint = "https://login.microsoftonline.com/"

configure_circuit_breaker = true

cosmos_db_account_name = "cosmos-export-demo"

cosmos_db_public_access = "Disabled"

cosmos_db_rus = 400

create_apim_gateway_key_secret = false

create_app_insights_dashboards = false

dns_subscription_id = ""

dns_zone_rg = ""

enable_agent_subnet = false

enable_ai_model_inference = true

enable_api_center = false

enable_api_center_onboarding = false

enable_azure_ai_search = false

enable_content_safety = true

enable_document_intelligence = false

enable_embeddings_backend = false

enable_entra_id_setup = false

enable_foundry_apim_connection = false

enable_jwt_auth = false

enable_logic_app_code_deploy = false

enable_openai_realtime = false

enable_pii_anonymization = false

enable_pii_redaction = true

enable_redis_cache = false

enable_unified_ai_api = true

entra_app_display_name_prefix = "ai-citadel-gateway"

entra_auth_enabled = false

entra_client_secret_name = "ENTRA-APP-CLIENT-SECRET"

entra_client_secret_rotation_days = 730

environment_name = "export-demo"

eventhub_capacity_units = 1

eventhub_disaster_recovery_config = null

eventhub_namespace_name = "eh-export-demo"

eventhub_network_access = "Disabled"

eventhub_partition_count = 4

existing_private_dns_zones = {}

existing_vnet_rg = "rg-export-network"

extra_llm_backends = []

foundry_network_injection_enabled = false

inference_api_type = "OpenAIV1"

is_mcp_sample_deployed = false

jwt_app_registration_id = ""

jwt_tenant_id = ""

key_vault_name = "kv-export-demo"

key_vault_sku = "standard"

kv_auto_detect_deployer_ip = false

kv_deployer_ip_rules = []

kv_public_network_access_enabled = false

llm_backend_config = []

location = "eastus2"

log_analytics_name = "law-export-demo"

logic_app_code_source_path = ""

logic_app_sku_size = "WS1"

logic_app_sku_tier = "WorkflowStandard"

logic_app_subnet_name = "snet-logic"

logic_content_share_name = "synthetic-content"

ms_learn_mcp_backend_url = "https://learn.microsoft.com/api/mcp"

network_acl_default_action = "Deny"

private_endpoint_subnet_name = "snet-pe"

purge_protection_enabled = true

purge_soft_delete_on_destroy = false

rbac_authorization_enabled = true

resource_group_name = "rg-export-demo"

soft_delete_retention_days = 7

subscription_id = "11111111-1111-4111-8111-111111111111"

tags = {
  "owner" = "example"
  "purpose" = "synthetic-export"
}

use_azure_monitor_private_link_scope = true

use_existing_log_analytics = false

use_existing_resource_group = true

use_existing_vnet = true

vnet_name = "vnet-export-demo"
