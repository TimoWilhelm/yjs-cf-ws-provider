export interface Env {
  YJS_VACUUM_INTERVAL_IN_MS: string | undefined;
  DURABLE_YJSPROVIDER: DurableObjectNamespace;
  R2_DEFAULT: R2Bucket;
}
