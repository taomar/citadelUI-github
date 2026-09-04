/**
 * @module publishApiCenter
 * @description Optional registration of a published asset (MCP/A2A) into Azure API Center. Thin wrapper
 * over the shared api-center-onboarding module that maps the publish-contract apiCenter config object
 * to that module's parameters. Only deployed when an asset sets publishToApiCenter=true.
 */

@description('API Center service name')
param apicServiceName string

@description('API Center workspace name')
param apicWorkspaceName string = 'default'

@description('API Center environment name (e.g. mcp-dev, mcp-prod, api-dev)')
param environmentName string

@description('Asset identifier (used as the API Center api name)')
param apiName string

@description('Asset display name')
param apiDisplayName string

@description('Asset description')
param apiDescription string = ''

@description('API Center kind: mcp | rest | a2a')
param apiKind string = 'mcp'

@description('Lifecycle stage: design | development | testing | preview | production | deprecated | retired')
param lifecycleStage string = 'development'

@description('Version name (e.g. 1-0-0)')
param versionName string = '1-0-0'

@description('Version display name (e.g. 1.0.0)')
param versionDisplayName string = '1.0.0'

@description('Gateway URL fronting the asset')
param gatewayUrl string

@description('Gateway path of the asset (e.g. weather-tool-mcp/mcp)')
param apiPath string

@description('API Center custom properties (metadata schema)')
param customProperties object = {}

@description('External documentation URL')
param documentationUrl string = ''

@description('Contacts array')
param contacts array = []

module registration '../../modules/apim/api-center-onboarding.bicep' = {
  name: 'apic-${apiName}'
  params: {
    apicServiceName: apicServiceName
    apicWorkspaceName: apicWorkspaceName
    environmentName: environmentName
    apiName: apiName
    apiDisplayName: apiDisplayName
    apiDescription: apiDescription
    apiKind: apiKind
    lifecycleStage: lifecycleStage
    versionName: versionName
    versionDisplayName: versionDisplayName
    gatewayUrl: gatewayUrl
    apiPath: apiPath
    customProperties: customProperties
    documentationUrl: documentationUrl
    contacts: contacts
  }
}

output apiCenterApiName string = registration.outputs.apiCenterApiName
