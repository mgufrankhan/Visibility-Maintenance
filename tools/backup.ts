/**
 * Backup, verification and restore.
 *
 *   npm run backup -- create --out-dir /backups
 *   npm run backup -- verify --dir /backups/<id>
 *   npm run backup -- restore --dir /backups/<id> [--restore-config]
 *
 * Env: PLATFORM_DATABASE_URL[_FILE], MAINTENANCE_DATABASE_URL[_FILE], BLOB_ROOT,
 * and the config file paths PLATFORM_SIGNING_KEY_FILE, SYSTEM_CREDENTIALS_FILE,
 * LICENSE_PUBLIC_KEYS_FILE, which are captured with the backup. PG_BIN_DIR
 * selects pg_dump/pg_restore matching the server's major version.
 *
 * Stop or fence API and worker containers before `restore`; restore only
 * targets empty databases and an empty blob root.
 */
import { parseArgs } from 'node:util';
import { createBackup, restoreBackup, verifyBackup } from '@vm/ops';
import { readSecret, requiredSecret } from '@vm/server-kit';
import { fail, print } from './lib/cli.ts';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { 'out-dir': { type: 'string' }, dir: { type: 'string' }, 'restore-config': { type: 'boolean', default: false } } });

const platformUrl = () => requiredSecret('PLATFORM_DATABASE_URL');
const maintenanceUrl = () => readSecret('MAINTENANCE_DATABASE_URL') ?? platformUrl();
const blobRoot = () => process.env.BLOB_ROOT ?? fail('BLOB_ROOT is required');
const configFiles = (): Record<string, string> => {
  const out: Record<string, string> = {};
  const add = (name: string, env: string) => {
    if (process.env[env]) out[name] = process.env[env]!;
  };
  add('identity-signing-key.json', 'PLATFORM_SIGNING_KEY_FILE');
  add('system-credentials.json', 'SYSTEM_CREDENTIALS_FILE');
  add('license-public-keys.json', 'LICENSE_PUBLIC_KEYS_FILE');
  return out;
};
const pgBinDir = process.env.PG_BIN_DIR;

switch (command) {
  case 'create': {
    const { dir, manifest } = await createBackup({
      platformDatabaseUrl: platformUrl(),
      maintenanceDatabaseUrl: maintenanceUrl(),
      blobRoot: blobRoot(),
      outDir: values['out-dir'] ?? fail('--out-dir is required'),
      configFiles: configFiles(),
      pgBinDir,
    });
    print({ dir, backup_id: manifest.backup_id, databases: manifest.databases.map((d) => ({ name: d.name, schema_versions: d.schema_versions })), blobs: manifest.blobs.files.length, blob_problems: manifest.blob_problems, pending_outbox_events: manifest.pending_outbox_events });
    if (manifest.blob_problems.length > 0) {
      console.error('Backup completed but some available attachments were missing or altered in the blob store; investigate before relying on it.');
      process.exit(3);
    }
    break;
  }
  case 'verify': {
    const { manifest, failures } = await verifyBackup(values.dir ?? fail('--dir is required'));
    print({ backup_id: manifest.backup_id, failures });
    if (failures.length > 0) process.exit(2);
    break;
  }
  case 'restore': {
    const targets: Record<string, string> = {};
    if (values['restore-config']) {
      for (const [name, file] of Object.entries(configFiles())) targets[name] = file;
    }
    const report = await restoreBackup({
      backupDir: values.dir ?? fail('--dir is required'),
      platformDatabaseUrl: platformUrl(),
      maintenanceDatabaseUrl: maintenanceUrl(),
      blobRoot: blobRoot(),
      configTargets: targets,
      pgBinDir,
    });
    print(report);
    if (!report.ok) process.exit(2);
    break;
  }
  default:
    fail('usage: backup <create|verify|restore> [options]; see tools/backup.ts');
}
