import { citadelRepositoryFiles } from '../../_citadel-fixture.mjs';

export const TAGS_PATH = 'bicep/infra/main.bicepparam';
export const SECOND_PATH = 'bicep/infra/second.bicepparam';
export const ROOT_TAGS = `{
  // This tag keeps its expression and its quoted key.
  'azd-env-name': readEnvironmentVariable('AZURE_ENV_NAME', 'synthetic-tags')
  SecurityControl: 'Ignore' // This comment belongs to SecurityControl.
}`;

export function tagsFiles({ tags = ROOT_TAGS, newline = '\r\n', bom = true } = {}) {
  const files = Object.fromEntries(Object.entries(citadelRepositoryFiles()).filter(([, value]) => typeof value === 'string'));
  const source = files[TAGS_PATH].replace("using './main.bicep'\n", `using './main.bicep'
// ============================================================================
// RESOURCE TAGS - Owned synthetic feature fixture
// ============================================================================
param tags = ${tags}
param ordinaryObject = {}
// Unrelated comment with punctuation: \${notAnExpression} & 'quoted'.
`);
  files[TAGS_PATH] = `${bom ? '\uFEFF' : ''}${source.replaceAll('\n', newline)}`;
  files['bicep/infra/main.bicep'] += "\n@description('Tags applied to resources.')\nparam tags object\nparam ordinaryObject object\n";
  files[SECOND_PATH] = `using './main.bicep'\nparam tags = { Other: 'second document' }\nparam ordinaryObject = {}\n`;
  return files;
}
