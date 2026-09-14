apim_name = "apim-export-demo"

aws_region = "us-east-1"

configure_circuit_breaker = true

llm_backend_config = [
  {
    "auth_scheme" = "managedIdentity"
    "auth_type" = "managed-identity"
    "backend_id" = "synthetic-east"
    "backend_type" = "azure-openai"
    "endpoint" = "https://synthetic-east.openai.azure.com"
    "priority" = 1
    "supported_models" = [
      {
        "apiVersion" = "2024-02-15-preview"
        "capacity" = 100
        "inferenceApiVersion" = ""
        "modelFormat" = "OpenAI"
        "modelVersion" = "2025-04-14"
        "name" = "gpt-4.1"
        "retirementDate" = ""
        "sku" = "GlobalStandard"
        "timeout" = 120
      },
    ]
    "weight" = 100
  },
]

managed_identity_client_id = "22222222-2222-4222-8222-222222222222"

model_aliases = [
  {
    "models" = [
      "gpt-4.1",
    ]
    "name" = "assistant"
    "strategy" = "priority"
    "weights" = []
  },
]

resource_group_name = "rg-export-demo"

subscription_id = "11111111-1111-4111-8111-111111111111"
