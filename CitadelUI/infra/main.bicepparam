using './main.bicep'

// Edit parameter values here before running azd up.
// Replace an expression with a literal to override the selected azd environment.
// For example: param existingContainerRegistryName = 'myregistry'
// Use '' for an existing-resource name to create the generated default instead.
// Never put passwords, tokens or credential-key values in this file.

// Network: true creates private networking; public owner sign-in is a separate opt-in.
param privateDeployment = bool(readEnvironmentVariable('CITADEL_PRIVATE_DEPLOYMENT', 'false'))
param allowPublicIngressWithoutAuth = bool(readEnvironmentVariable('ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH', 'false'))

// Select a subnet for a NEW environment, OR an existing environment, never both.
param infrastructureSubnetId = readEnvironmentVariable('AZURE_INFRASTRUCTURE_SUBNET_ID', '')
param existingContainerAppsEnvironmentName = readEnvironmentVariable('AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME', '')
param existingContainerAppsEnvironmentResourceGroup = readEnvironmentVariable('AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP', '')

// An existing environment keeps its logging: leave workspace selectors empty then.
param existingLogAnalyticsWorkspaceName = readEnvironmentVariable('AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME', '')
param existingLogAnalyticsWorkspaceResourceGroup = readEnvironmentVariable('AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP', '')

// Existing names are optional. Empty resource-group values mean the UI resource group.
param existingContainerRegistryName = readEnvironmentVariable('AZURE_EXISTING_CONTAINER_REGISTRY_NAME', '')
param existingContainerRegistryResourceGroup = readEnvironmentVariable('AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP', '')
param keyVaultName = readEnvironmentVariable('AZURE_KEY_VAULT_NAME', '')
param keyVaultResourceGroup = readEnvironmentVariable('AZURE_KEY_VAULT_RESOURCE_GROUP', '')
param credentialSecretName = readEnvironmentVariable('CITADEL_CREDENTIAL_SECRET_NAME', 'citadel-credential-key')
param existingStorageAccountName = readEnvironmentVariable('AZURE_EXISTING_STORAGE_ACCOUNT_NAME', '')
param existingStorageAccountResourceGroup = readEnvironmentVariable('AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP', '')
param existingFileShareName = readEnvironmentVariable('AZURE_EXISTING_FILE_SHARE_NAME', '')
param existingManagedIdentityName = readEnvironmentVariable('AZURE_EXISTING_MANAGED_IDENTITY_NAME', '')
param existingManagedIdentityResourceGroup = readEnvironmentVariable('AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP', '')

// azd supplies deployment context and retains the current image. Leave these unchanged.
param environmentName = readEnvironmentVariable('AZURE_ENV_NAME')
param location = readEnvironmentVariable('AZURE_LOCATION')
param principalId = readEnvironmentVariable('AZURE_PRINCIPAL_ID', '')
param principalType = readEnvironmentVariable('AZURE_PRINCIPAL_TYPE', 'User')
param citadelUiImageName = readEnvironmentVariable('SERVICE_CITADELUI_IMAGE_NAME', '')

// Existing optional authentication configuration stays environment-only.
param entraAuthClientId = readEnvironmentVariable('AZURE_AUTH_CLIENT_ID', '')
param entraAuthClientSecret = readEnvironmentVariable('AZURE_AUTH_CLIENT_SECRET', '')
