import { openKafkaSession, testKafkaConnection } from '@datakit/adapter-kafka';
import { openMongoSession, testMongoConnection } from '@datakit/adapter-mongodb';
import { openMysqlSession, testMysqlConnection } from '@datakit/adapter-mysql';
import { openPostgresSession, testPostgresConnection } from '@datakit/adapter-postgres';
import { openRedisSession, testRedisConnection } from '@datakit/adapter-redis';
import type { ConnectionTestResult, DataSourceSettings, EngineId, Secrets, ServerSession } from '@datakit/core';

/** What the extension needs from an adapter. */
export interface Driver {
  open(settings: DataSourceSettings, secrets: Secrets): Promise<ServerSession>;
  test(settings: DataSourceSettings, secrets: Secrets): Promise<ConnectionTestResult>;
}

const DRIVERS: Record<EngineId, Driver> = {
  mysql: { open: openMysqlSession, test: testMysqlConnection },
  postgres: { open: openPostgresSession, test: testPostgresConnection },
  redis: { open: openRedisSession, test: testRedisConnection },
  kafka: { open: openKafkaSession, test: testKafkaConnection },
  mongodb: { open: openMongoSession, test: testMongoConnection },
};

export function driverFor(engine: EngineId): Driver {
  return DRIVERS[engine];
}
