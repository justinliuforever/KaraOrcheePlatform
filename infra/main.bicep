@description('Environment suffix (dev | prod)')
@allowed(['dev', 'prod'])
param env string

// Subscription is Postgres-offer-restricted in eastus/eastus2/westus2/southcentralus;
// centralus is the nearest full-featured allowed region, so the whole platform lives there.
param location string = 'centralus'

param pgLocation string = location

param pgServerName string = 'pg-karaorchee-app-${env}'

@secure()
param pgAdminPassword string

@description('Object ID granted Key Vault secret access (founder / operator)')
param operatorObjectId string

var tags = { product: 'karaorchee-app', env: env }

@description('Expire lesson transcripts at 90 days. Changes retention of data that already exists — founder sign-off required before enabling.')
param transcriptRetentionEnabled bool = false

@description('Move narration older than 30 days to cool storage. Cool-tier reads bill extra, so this can cost more than it saves if students revisit old notes.')
param narrationCoolTieringEnabled bool = false

resource logws 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-karaorchee-app-${env}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-karaorchee-app-${env}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logws.id
  }
}

resource st 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stkaraoapp${env}'
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobSvc 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: st
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
    isVersioningEnabled: true
  }
}

var containerNames = ['piece-bundles', 'piece-sources', 'soundfont', 'lesson-audio', 'notes-assets']

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for c in containerNames: {
    parent: blobSvc
    name: c
    properties: { publicAccess: 'None' }
  }
]

// Raw lesson audio is only needed until notes are produced + a dispute window.
// Applying this by CLI needs `az storage account management-policy create` — the
// `update --policy @file` form is rejected, and create upserts.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: st
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'lesson-audio-cool-then-delete'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['lesson-audio/'] }
            actions: {
              baseBlob: {
                tierToCool: { daysAfterModificationGreaterThan: 30 }
                delete: { daysAfterModificationGreaterThan: 90 }
              }
              // Without this a superseded version of a lesson recording never expires at all.
              version: {
                delete: { daysAfterCreationGreaterThan: 7 }
              }
            }
          }
        }
        // Deleted/overwritten blob VERSIONS only. managementPolicies is replace-all, so
        // omitting a live rule here silently drops it on the next deploy.
        {
          name: 'notes-assets-purge-deleted-versions'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['notes-assets/'] }
            actions: {
              version: {
                delete: { daysAfterCreationGreaterThan: 30 }
              }
            }
          }
        }
        // A transcript is the recording in another encoding — verbatim lesson speech,
        // often a minor's. The app tells users the audio is gone from the cloud at 90
        // days, so its verbatim derivative expires on the same clock. The note, its
        // annotations and their quotes are the durable record and are unaffected.
        {
          name: 'notes-transcripts-delete'
          enabled: transcriptRetentionEnabled
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['notes-assets/transcripts/'] }
            actions: {
              baseBlob: {
                delete: { daysAfterModificationGreaterThan: 90 }
              }
            }
          }
        }
        // Narration is machine-spoken NOTE text, not a recording of anyone, and the
        // note it belongs to never expires — so no time-based delete: it is purged
        // with its note (note/lesson/account deletion). A future prefix holding a
        // teacher's REAL voice is a recording and needs the 90-day rule above.
        {
          name: 'notes-narration-cool'
          enabled: narrationCoolTieringEnabled
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['notes-assets/narration/'] }
            actions: {
              baseBlob: {
                tierToCool: { daysAfterModificationGreaterThan: 30 }
              }
            }
          }
        }
      ]
    }
  }
}

resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: 'sb-karaorchee-app-${env}'
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Standard' }
}

resource notesQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sb
  name: 'notes-jobs'
  properties: {
    maxDeliveryCount: 5
    lockDuration: 'PT5M'
    deadLetteringOnMessageExpiration: true
    defaultMessageTimeToLive: 'P1D'
  }
}

// Narration's own lane. A synthesis run is minutes long and must neither wait behind an
// ASR job nor hold one's lock; the worker consumes it on a separate thread. Redelivery
// costs nothing already paid for — a clip whose content hash still matches is skipped.
resource notesNarrationQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sb
  name: 'notes-narration'
  properties: {
    maxDeliveryCount: 5
    lockDuration: 'PT5M'
    deadLetteringOnMessageExpiration: true
    defaultMessageTimeToLive: 'P1D'
  }
}

resource piecesQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sb
  name: 'pieces-jobs'
  properties: {
    maxDeliveryCount: 3
    lockDuration: 'PT5M'
    defaultMessageTimeToLive: 'P1D'
  }
}

// Wizard fast lane: sanity/alignment/geometry gates run while the admin is still
// filling the form. Short TTL — a stale preflight is worthless.
resource piecesPreflightQueue 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sb
  name: 'pieces-preflight'
  properties: {
    maxDeliveryCount: 3
    lockDuration: 'PT5M'
    defaultMessageTimeToLive: 'PT1H'
  }
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-karaorchee-app-${env}'
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: tenant().tenantId
    enabledForTemplateDeployment: true
    accessPolicies: [
      {
        tenantId: tenant().tenantId
        objectId: operatorObjectId
        permissions: { secrets: ['get', 'list', 'set', 'delete'] }
      }
    ]
  }
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgServerName
  location: pgLocation
  tags: tags
  sku: {
    name: env == 'prod' ? 'Standard_B2s' : 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: 'karaorchee_admin'
    administratorLoginPassword: pgAdminPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
  }
}

resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-karaorchee-app-${env}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logws.properties.customerId
        sharedKey: logws.listKeys().primarySharedKey
      }
    }
  }
}

// ⚠️ DRIFT WARNING: the live container apps carry image tags, secrets (dburl/
// storagecs/sbcs), and env (AUTH_*, ADMIN_ORIGINS) applied via `az` CLI — NOT
// declared here. Re-running this deployment against a live env resets them.
// The pieces worker app (ca-pieces-worker-<env>) is CLI-managed and not declared
// here at all. Reconcile before creating prod.
// Placeholder image until the API image lands in ACR; swap via `az containerapp update`.
resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-app-api-${env}'
  location: location
  tags: tags
  properties: {
    managedEnvironmentId: cae.id
    configuration: {
      ingress: { external: true, targetPort: 8080, transport: 'auto' }
    }
    template: {
      containers: [
        {
          name: 'api'
          image: 'mcr.microsoft.com/k8se/quickstart:latest'
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
      scale: {
        // dev stays warm too — no cold starts during testing (founder call 2026-07-05).
        minReplicas: 1
        maxReplicas: env == 'prod' ? 3 : 1
      }
    }
  }
}

output storageAccountName string = st.name
output blobEndpoint string = st.properties.primaryEndpoints.blob
output serviceBusNamespace string = sb.name
output keyVaultUri string = kv.properties.vaultUri
output postgresFqdn string = pg.properties.fullyQualifiedDomainName
output apiFqdn string = api.properties.configuration.ingress.fqdn
output appInsightsConnectionString string = appi.properties.ConnectionString
