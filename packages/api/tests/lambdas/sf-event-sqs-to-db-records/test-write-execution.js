'use strict';

const test = require('ava');
const cryptoRandomString = require('crypto-random-string');
const sinon = require('sinon');
const uuidv4 = require('uuid/v4');

const {
  localStackConnectionEnv,
  getKnexClient,
  tableNames,
  doesRecordExist,
} = require('@cumulus/db');
const {
  MissingRequiredEnvVarError,
  UnmetRequirementsError,
} = require('@cumulus/errors');

const { migrationDir } = require('../../../../../lambdas/db-migration');
const Execution = require('../../../models/executions');

const {
  buildExecutionRecord,
  getWriteExecutionRequirements,
  shouldWriteExecutionToPostgres,
  writeRunningExecutionViaTransaction,
  writeExecutionViaTransaction,
  writeExecution,
} = require('../../../lambdas/sf-event-sqs-to-db-records/write-execution');

test.before(async (t) => {
  process.env.ExecutionsTable = cryptoRandomString({ length: 10 });

  const executionModel = new Execution();
  await executionModel.createTable();
  t.context.executionModel = executionModel;

  t.context.testDbName = `writeExecutions_${cryptoRandomString({ length: 10 })}`;

  t.context.knexAdmin = await getKnexClient({ env: localStackConnectionEnv });
  await t.context.knexAdmin.raw(`create database "${t.context.testDbName}";`);
  await t.context.knexAdmin.raw(`grant all privileges on database "${t.context.testDbName}" to "${localStackConnectionEnv.PG_USER}"`);

  t.context.knex = await getKnexClient({
    env: {
      ...localStackConnectionEnv,
      PG_DATABASE: t.context.testDbName,
      migrationDir,
    },
  });
  await t.context.knex.migrate.latest();
});

test.beforeEach((t) => {
  process.env.RDS_DEPLOYMENT_CUMULUS_VERSION = '3.0.0';
  t.context.postRDSDeploymentVersion = '4.0.0';
  t.context.preRDSDeploymentVersion = '2.9.99';

  const stateMachineName = cryptoRandomString({ length: 5 });
  t.context.stateMachineArn = `arn:aws:states:us-east-1:12345:stateMachine:${stateMachineName}`;

  t.context.executionName = cryptoRandomString({ length: 5 });
  t.context.executionArn = `arn:aws:states:us-east-1:12345:execution:${stateMachineName}:${t.context.executionName}`;

  t.context.workflowStartTime = Date.now();
  t.context.workflowTasks = {
    task1: {
      key: 'value',
    },
  };
  t.context.workflowName = 'TestWorkflow';

  t.context.asyncOperationId = uuidv4();
  t.context.collectionNameVersion = {
    name: cryptoRandomString({ length: 5 }),
    version: '0.0.0',
  };
  t.context.parentExecutionArn = `arn${cryptoRandomString({ length: 5 })}`;

  t.context.cumulusMessage = {
    cumulus_meta: {
      workflow_start_time: t.context.workflowStartTime,
      cumulus_version: t.context.postRDSDeploymentVersion,
      state_machine: t.context.stateMachineArn,
      execution_name: t.context.executionName,
    },
    meta: {
      status: 'running',
      workflow_name: t.context.workflowName,
      workflow_tasks: t.context.workflowTasks,
    },
    payload: {
      foo: 'bar',
    },
  };
});

test.after.always(async (t) => {
  const {
    executionModel,
  } = t.context;
  await executionModel.deleteTable();
  await t.context.knex.destroy();
  await t.context.knexAdmin.raw(`drop database if exists "${t.context.testDbName}"`);
  await t.context.knexAdmin.destroy();
});

test('getWriteExecutionRequirements() throws UnmetRequirementsError for pre-RDS deployment execution message', async (t) => {
  const { cumulusMessage, preRDSDeploymentVersion, knex } = t.context;
  await t.throwsAsync(
    getWriteExecutionRequirements({
      cumulusMessage: {
        ...cumulusMessage,
        cumulus_meta: {
          ...cumulusMessage.cumulus_meta,
          cumulus_version: preRDSDeploymentVersion,
        },
      },
      knex,
    }),
    { instanceOf: UnmetRequirementsError }
  );
});

test('getWriteExecutionRequirements() throws UnmetRequirementsError if collection from message is not found in Postgres', async (t) => {
  const {
    cumulusMessage,
    collectionNameVersion,
    knex,
  } = t.context;

  await t.throwsAsync(
    getWriteExecutionRequirements({
      cumulusMessage,
      messageCollectionNameVersion: collectionNameVersion,
      collectionCumulusId: undefined,
      knex,
    }),
    { instanceOf: UnmetRequirementsError }
  );
});

test('getWriteExecutionRequirements() throws UnmetRequirementsError if async operation from message is not found in Postgres', async (t) => {
  const {
    cumulusMessage,
    asyncOperationId,
    collectionNameVersion,
    knex,
  } = t.context;

  cumulusMessage.cumulus_meta.asyncOperationId = asyncOperationId;

  await t.throwsAsync(
    getWriteExecutionRequirements({
      cumulusMessage,
      messageCollectionNameVersion: collectionNameVersion,
      collectionCumulusId: 1,
      knex,
    }),
    { instanceOf: UnmetRequirementsError }
  );
});

test('getWriteExecutionRequirements() throws UnmetRequirementsError if parent execution from message is not found in Postgres', async (t) => {
  const {
    cumulusMessage,
    collectionNameVersion,
    parentExecutionArn,
    knex,
  } = t.context;

  cumulusMessage.cumulus_meta.parentExecutionArn = parentExecutionArn;

  await t.throwsAsync(
    getWriteExecutionRequirements({
      cumulusMessage,
      messageCollectionNameVersion: collectionNameVersion,
      collectionCumulusId: 1,
      knex,
    }),
    { instanceOf: UnmetRequirementsError }
  );
});

test('getWriteExecutionRequirements() sucessfully returns record IDs', async (t) => {
  const {
    cumulusMessage,
    asyncOperationId,
    collectionNameVersion,
    parentExecutionArn,
  } = t.context;

  cumulusMessage.cumulus_meta.asyncOperationId = asyncOperationId;
  cumulusMessage.cumulus_meta.parentExecutionArn = parentExecutionArn;

  const fakeKnex = () => ({
    where: (params) => ({
      first: async () => {
        if (params.id === asyncOperationId) {
          return {
            cumulus_id: 52,
          };
        }
        if (params.arn === parentExecutionArn) {
          return {
            cumulus_id: 73,
          };
        }
        return undefined;
      },
    }),
  });

  t.deepEqual(
    await getWriteExecutionRequirements({
      cumulusMessage,
      messageCollectionNameVersion: collectionNameVersion,
      collectionCumulusId: 1,
      knex: fakeKnex,
    }),
    {
      asyncOperationCumulusId: 52,
      parentExecutionCumulusId: 73,
    }
  );
});

test.serial('getWriteExecutionRequirements() throws error if RDS_DEPLOYMENT_CUMULUS_VERSION env var is missing', async (t) => {
  const {
    knex,
    cumulusMessage,
    collectionNameVersion,
    collectionCumulusId,
  } = t.context;

  delete process.env.RDS_DEPLOYMENT_CUMULUS_VERSION;
  await t.throwsAsync(
    getWriteExecutionRequirements({
      cumulusMessage,
      messageCollectionNameVersion: collectionNameVersion,
      collectionCumulusId,
      knex,
    }),
    { instanceOf: MissingRequiredEnvVarError }
  );
});

test('buildExecutionRecord builds correct record for "running" execution', (t) => {
  const {
    cumulusMessage,
    executionArn,
    postRDSDeploymentVersion,
    workflowName,
    workflowTasks,
  } = t.context;

  const now = new Date();
  const record = buildExecutionRecord({
    cumulusMessage,
    now,
    asyncOperationCumulusId: 1,
    collectionCumulusId: 2,
    parentExecutionCumulusId: 3,
  });

  t.deepEqual(
    record,
    {
      arn: executionArn,
      cumulus_version: postRDSDeploymentVersion,
      duration: 0,
      original_payload: cumulusMessage.payload,
      status: 'running',
      tasks: workflowTasks,
      url: `https://console.aws.amazon.com/states/home?region=us-east-1#/executions/details/${executionArn}`,
      workflow_name: workflowName,
      error: {},
      final_payload: undefined,
      async_operation_cumulus_id: 1,
      collection_cumulus_id: 2,
      parent_cumulus_id: 3,
      created_at: new Date(cumulusMessage.cumulus_meta.workflow_start_time),
      timestamp: now,
      updated_at: now,
    }
  );
});

test('buildExecutionRecord returns record with correct payload for non-running execution', (t) => {
  const {
    cumulusMessage,
  } = t.context;

  cumulusMessage.meta.status = 'completed';

  const record = buildExecutionRecord({
    cumulusMessage,
  });

  t.is(record.status, 'completed');
  t.is(record.original_payload, undefined);
  t.deepEqual(record.final_payload, cumulusMessage.payload);
});

test('buildExecutionRecord returns record with duration', (t) => {
  const {
    cumulusMessage,
    workflowStartTime,
  } = t.context;

  cumulusMessage.meta.status = 'completed';
  cumulusMessage.cumulus_meta.workflow_stop_time = workflowStartTime + 5000;

  const record = buildExecutionRecord({
    cumulusMessage,
  });

  t.is(record.duration, 5);
});

test('buildExecutionRecord returns record with error', (t) => {
  const {
    cumulusMessage,
  } = t.context;

  cumulusMessage.meta.status = 'failed';
  const exception = {
    Error: new Error('fake error'),
    Cause: 'an error occurred',
  };
  cumulusMessage.exception = exception;

  const record = buildExecutionRecord({
    cumulusMessage,
  });

  t.deepEqual(record.error, exception);
});

test('writeRunningExecutionViaTransaction only updates allowed fields on conflict', async (t) => {
  const { executionArn, knex } = t.context;
  const initialDatetime = new Date();
  const executionRecord = {
    arn: executionArn,
    status: 'running',
    url: 'first-url',
    original_payload: {
      key: 'value',
    },
    created_at: initialDatetime,
    updated_at: initialDatetime,
    timestamp: initialDatetime,
    workflow_name: 'TestWorkflow',
  };
  await knex(tableNames.executions).insert(executionRecord);

  const newPayload = {
    key2: 'value2',
  };
  const newDatetime = new Date();
  executionRecord.created_at = newDatetime;
  executionRecord.updated_at = newDatetime;
  executionRecord.timestamp = newDatetime;
  executionRecord.original_payload = newPayload;
  executionRecord.workflow_name = 'TestWorkflow2';
  executionRecord.url = 'new-url';

  await knex.transaction(
    (trx) =>
      writeRunningExecutionViaTransaction({
        trx,
        executionRecord,
      })
  );
  const updatedRecord = await knex(tableNames.executions)
    .where({ arn: executionArn })
    .first();
  t.is(updatedRecord.status, 'running');
  // should have been updated
  t.deepEqual(updatedRecord.original_payload, newPayload);
  t.deepEqual(updatedRecord.timestamp, newDatetime);
  t.deepEqual(updatedRecord.updated_at, newDatetime);
  t.deepEqual(updatedRecord.created_at, newDatetime);
  // should not have been updated
  t.is(updatedRecord.url, 'first-url');
  t.is(updatedRecord.workflow_name, 'TestWorkflow');
});

test('writeExecutionViaTransaction() writes record with foreign key references', async (t) => {
  const { executionArn, cumulusMessage, knex } = t.context;

  const asyncOperation = {
    id: uuidv4(),
    description: 'test async operation',
    operation_type: 'Bulk Granules',
    status: 'RUNNING',
  };
  cumulusMessage.cumulus_meta.asyncOperationId = asyncOperation.id;

  const asyncOperationResult = await knex(tableNames.asyncOperations)
    .insert(asyncOperation)
    .returning('cumulus_id');

  await knex.transaction(
    (trx) =>
      writeExecutionViaTransaction({
        cumulusMessage,
        asyncOperationCumulusId: asyncOperationResult[0],
        trx,
      })
  );

  const record = await knex(tableNames.executions)
    .where({ arn: executionArn })
    .first();

  // Do I need to test that all the foreign key writes are successful?
  // parent execution, collection?
  t.is(record.async_operation_cumulus_id, asyncOperationResult[0]);
});

test('writeExecutionViaTransaction() can be used to create a new running execution', async (t) => {
  const { executionArn, cumulusMessage, knex } = t.context;

  await knex.transaction(
    (trx) =>
      writeExecutionViaTransaction({
        cumulusMessage,
        trx,
      })
  );

  const record = await knex(tableNames.executions)
    .where({ arn: executionArn })
    .first();

  t.is(record.status, 'running');
});

test('writeExecutionViaTransaction() can be used to update a running execution', async (t) => {
  const { executionArn, cumulusMessage, knex } = t.context;

  await knex.transaction(
    (trx) =>
      writeExecutionViaTransaction({
        cumulusMessage,
        trx,
      })
  );

  const newPayload = {
    key: cryptoRandomString({ length: 5 }),
  };
  cumulusMessage.payload = newPayload;

  await knex.transaction(
    (trx) =>
      writeExecutionViaTransaction({
        cumulusMessage,
        trx,
      })
  );

  const record = await knex(tableNames.executions)
    .where({ arn: executionArn })
    .first();

  t.is(record.status, 'running');
  t.deepEqual(record.original_payload, newPayload);
});

test('writeExecutionViaTransaction() can be used to create a completed execution', async (t) => {
  const { executionArn, cumulusMessage, knex } = t.context;

  cumulusMessage.meta.status = 'completed';

  await knex.transaction(
    (trx) =>
      writeExecutionViaTransaction({
        cumulusMessage,
        trx,
      })
  );

  const record = await knex(tableNames.executions)
    .where({ arn: executionArn })
    .first();

  t.is(record.status, 'completed');
});

test('writeExecutionViaTransaction() can be used to updated a completed execution', async (t) => {
  const { executionArn, cumulusMessage, knex } = t.context;

  cumulusMessage.meta.status = 'completed';

  await knex.transaction(
    (trx) =>
      writeExecutionViaTransaction({
        cumulusMessage,
        trx,
      })
  );

  const newPayload = {
    key: cryptoRandomString({ length: 3 }),
  };
  cumulusMessage.payload = newPayload;

  await knex.transaction(
    (trx) =>
      writeExecutionViaTransaction({
        cumulusMessage,
        trx,
      })
  );

  const record = await knex(tableNames.executions)
    .where({ arn: executionArn })
    .first();

  t.is(record.status, 'completed');
  t.deepEqual(record.final_payload, newPayload);
});

test('writeExecutionViaTransaction() will not allow a running status to replace a completed status', async (t) => {
  const { executionArn, cumulusMessage, knex } = t.context;

  cumulusMessage.meta.status = 'completed';

  await knex.transaction(
    (trx) =>
      writeExecutionViaTransaction({
        cumulusMessage,
        trx,
      })
  );

  cumulusMessage.meta.status = 'running';

  await knex.transaction(
    (trx) =>
      writeExecutionViaTransaction({
        cumulusMessage,
        trx,
      })
  );

  const record = await knex(tableNames.executions)
    .where({ arn: executionArn })
    .first();

  t.is(record.status, 'completed');
});

test('writeExecution() saves execution to Dynamo and RDS and returns cumulus_id if write to RDS is enabled', async (t) => {
  const {
    cumulusMessage,
    knex,
    executionModel,
    executionArn,
  } = t.context;

  const executionCumulusId = await writeExecution({ cumulusMessage, knex });

  t.true(await executionModel.exists({ arn: executionArn }));
  t.true(
    await doesRecordExist({
      cumulus_id: executionCumulusId,
    }, knex, tableNames.executions)
  );
});

test.serial('writeExecution() does not persist records to Dynamo or RDS if Dynamo write fails', async (t) => {
  const {
    cumulusMessage,
    knex,
    executionModel,
    executionArn,
  } = t.context;

  const fakeExecutionModel = {
    storeExecutionFromCumulusMessage: () => {
      throw new Error('execution Dynamo error');
    },
  };

  await t.throwsAsync(
    writeExecution({
      cumulusMessage,
      knex,
      executionModel: fakeExecutionModel,
    }),
    { message: 'execution Dynamo error' }
  );
  t.false(await executionModel.exists({ arn: executionArn }));
  t.false(
    await doesRecordExist({
      arn: executionArn,
    }, knex, tableNames.executions)
  );
});

test.serial('writeExecution() does not persist records to Dynamo or RDS if RDS write fails', async (t) => {
  const {
    cumulusMessage,
    knex,
    executionModel,
    executionArn,
  } = t.context;

  const fakeTrxCallback = (cb) => {
    const fakeTrx = sinon.stub().returns({
      insert: () => {
        throw new Error('execution RDS error');
      },
    });
    return cb(fakeTrx);
  };
  const trxStub = sinon.stub(knex, 'transaction').callsFake(fakeTrxCallback);
  t.teardown(() => trxStub.restore());

  await t.throwsAsync(
    writeExecution({ cumulusMessage, knex }),
    { message: 'execution RDS error' }
  );
  t.false(await executionModel.exists({ arn: executionArn }));
  t.false(
    await doesRecordExist({
      arn: executionArn,
    }, knex, tableNames.executions)
  );
});
