import { readSecret, requiredSecret } from '@vm/server-kit';

export interface MaintenanceApiConfig {
  databaseUrl: string;
  platformUrl: string;
  issuer: string;
  jwksUrl: string;
  port: number;
  host: string;
  blobRoot: string;
  downloadLinkSecret: string;
  licensePublicKeysFile: string | undefined;
  systemCredentialsFile: string | undefined;
  allowSimulatedConnectors: boolean;
  neoInferencePolicy: 'disabled' | 'private_only' | 'cloud_permitted';
  production: boolean;
  monitoringToken: string | undefined;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function loadMaintenanceConfig(): MaintenanceApiConfig {
  const platformUrl = required('PLATFORM_URL');
  const production = process.env.NODE_ENV === 'production';
  const allowSimulated = process.env.ALLOW_SIMULATED_CONNECTORS === 'true';
  if (production && allowSimulated && process.env.I_UNDERSTAND_SIMULATED_CONNECTORS_ARE_NOT_PRODUCTION !== 'yes') {
    throw new Error('Simulated connectors cannot be enabled in production without explicit acknowledgment');
  }
  const policy = process.env.NEO_INFERENCE_POLICY ?? 'disabled';
  if (!['disabled', 'private_only', 'cloud_permitted'].includes(policy)) throw new Error('Invalid NEO_INFERENCE_POLICY');
  return {
    databaseUrl: requiredSecret('MAINTENANCE_DATABASE_URL'),
    platformUrl,
    issuer: required('TOKEN_ISSUER'),
    jwksUrl: process.env.TOKEN_JWKS_URL ?? `${platformUrl.replace(/\/$/, '')}/api/v1/identity/jwks`,
    port: Number(process.env.PORT ?? 4200),
    host: process.env.HOST ?? '0.0.0.0',
    blobRoot: required('BLOB_ROOT'),
    downloadLinkSecret: requiredSecret('DOWNLOAD_LINK_SECRET'),
    licensePublicKeysFile: process.env.LICENSE_PUBLIC_KEYS_FILE,
    systemCredentialsFile: process.env.SYSTEM_CREDENTIALS_FILE,
    allowSimulatedConnectors: allowSimulated,
    neoInferencePolicy: policy as MaintenanceApiConfig['neoInferencePolicy'],
    production,
    monitoringToken: readSecret('MONITORING_TOKEN'),
  };
}
