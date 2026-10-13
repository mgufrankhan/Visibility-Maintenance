import { describe, expect, it } from 'vitest';
import { S3BlobStore, blobStoreFromEnv } from '../../packages/core/src/blob-store-s3.ts';
import { FilesystemBlobStore } from '../../packages/core/src/blob-store.ts';

describe('S3 blob store driver selection (D18)', () => {
  it('defaults to filesystem', () => {
    const prev = process.env.BLOB_STORE;
    delete process.env.BLOB_STORE;
    try {
      expect(blobStoreFromEnv('/tmp/vm-blobs-test').kind).toBe('filesystem');
      expect(blobStoreFromEnv('/tmp/vm-blobs-test')).toBeInstanceOf(FilesystemBlobStore);
    } finally {
      if (prev === undefined) delete process.env.BLOB_STORE;
      else process.env.BLOB_STORE = prev;
    }
  });

  it('refuses s3 without required configuration', () => {
    const prev = process.env.BLOB_STORE;
    process.env.BLOB_STORE = 's3';
    delete process.env.S3_ENDPOINT;
    try {
      expect(() => blobStoreFromEnv('/tmp')).toThrow(/S3_ENDPOINT/);
    } finally {
      if (prev === undefined) delete process.env.BLOB_STORE;
      else process.env.BLOB_STORE = prev;
    }
  });

  it('constructs an s3 driver for an explicit local endpoint', () => {
    const store = new S3BlobStore({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'vm',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    expect(store.kind).toBe('s3');
  });
});
