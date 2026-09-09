api_name_mapping = {
  "LLM" = [
    "universal-llm-api",
    "azure-openai-api",
  ]
  "SEARCH" = [
    "ai-search-api",
  ]
}

apim = {
  "name" = "apim-export-demo"
  "resource_group_name" = "rg-export-demo"
  "subscription_id" = "11111111-1111-4111-8111-111111111111"
}

key_vault = {
  "name" = "kv-export-demo"
  "resource_group_name" = "rg-export-demo"
  "subscription_id" = "11111111-1111-4111-8111-111111111111"
}

product_terms = "Synthetic example only. Not deployed."

services = [
  {
    "api_key_secret_name" = "FINANCE-LLM-KEY"
    "code" = "LLM"
    "endpoint_secret_name" = "FINANCE-LLM-ENDPOINT"
    "policy_xml" = "<policies>\n  <inbound>\n    <base />\n    <set-variable name=\"allowed-models\" value=\"gpt-4.1,gpt-5.4-mini\" />\n    <set-variable name=\"literal-data\" value=\"$${not_a_terraform_expression} %%{not_a_directive} {{named-value}}\" />\n    <set-header name=\"x-synthetic-label\" exists-action=\"override\"><value>Café export</value></set-header>\n  </inbound>\n  <backend><base /></backend>\n  <outbound><base /></outbound>\n  <on-error><base /></on-error>\n</policies>\n"
  },
]

use_case = {
  "business_unit" = "finance"
  "environment" = "demo"
  "use_case_name" = "assistant"
}

use_target_foundry = false

use_target_key_vault = true
