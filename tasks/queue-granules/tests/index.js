'use strict';

const test = require('ava');
const proxyquire = require('proxyquire');
const {
  s3,
  sqs,
} = require('@cumulus/aws-client/services');
const { createQueue } = require('@cumulus/aws-client/SQS');
const { recursivelyDeleteS3Bucket, s3PutObject } = require('@cumulus/aws-client/S3');
const { buildExecutionArn } = require('@cumulus/message/Executions');
const CollectionConfigStore = require('@cumulus/collection-config-store');
const {
  randomNumber,
  randomString,
  validateConfig,
  validateInput,
  validateOutput,
} = require('@cumulus/common/test-utils');
const sinon = require('sinon');
const pMap = require('p-map');

const pMapSpy = sinon.spy(pMap);

const { queueGranules } = proxyquire('..', { 'p-map': pMapSpy });

test.beforeEach(async (t) => {
  pMapSpy.resetHistory();

  t.context.internalBucket = `internal-bucket-${randomString().slice(0, 6)}`;
  t.context.stackName = `stack-${randomString().slice(0, 6)}`;
  t.context.workflow = randomString();
  t.context.stateMachineArn = randomString();
  t.context.collectionConfigStore = new CollectionConfigStore(
    t.context.internalBucket,
    t.context.stackName
  );

  await s3().createBucket({ Bucket: t.context.internalBucket }).promise();

  t.context.queueUrl = await createQueue(randomString());

  t.context.queueExecutionLimits = {
    [t.context.queueUrl]: randomNumber(),
  };
  t.context.messageTemplate = {
    cumulus_meta: {
      queueUrl: t.context.queueUrl,
      queueExecutionLimits: t.context.queueExecutionLimits,
    },
  };
  const workflowDefinition = {
    name: t.context.workflow,
    arn: t.context.stateMachineArn,
  };
  const messageTemplateKey = `${t.context.stackName}/workflow_template.json`;
  const workflowDefinitionKey = `${t.context.stackName}/workflows/${t.context.workflow}.json`;
  t.context.messageTemplateKey = messageTemplateKey;
  await Promise.all([
    s3PutObject({
      Bucket: t.context.internalBucket,
      Key: messageTemplateKey,
      Body: JSON.stringify(t.context.messageTemplate),
    }),
    s3PutObject({
      Bucket: t.context.internalBucket,
      Key: workflowDefinitionKey,
      Body: JSON.stringify(workflowDefinition),
    }),
  ]);

  t.context.event = {
    config: {
      internalBucket: t.context.internalBucket,
      stackName: t.context.stackName,
      provider: { name: 'provider-name' },
      queueUrl: t.context.queueUrl,
      granuleIngestWorkflow: t.context.workflow,
    },
    input: {
      granules: [],
    },
  };
});

test.afterEach(async (t) => {
  await Promise.all([
    recursivelyDeleteS3Bucket(t.context.internalBucket),
    sqs().deleteQueue({ QueueUrl: t.context.event.config.queueUrl }).promise(),
  ]);
});

test.serial('The correct output is returned when granules are queued without a PDR', async (t) => {
  const dataType = `data-type-${randomString().slice(0, 6)}`;
  const version = '6';
  const collectionConfig = { foo: 'bar' };
  await t.context.collectionConfigStore.put(dataType, version, collectionConfig);

  const { event } = t.context;
  event.input.granules = [
    {
      dataType, version, granuleId: randomString(), files: [],
    },
    {
      dataType, version, granuleId: randomString(), files: [],
    },
  ];

  await validateConfig(t, event.config);
  await validateInput(t, event.input);

  const output = await queueGranules(event);

  await validateOutput(t, output);
  t.is(output.running.length, 2);
  t.falsy(output.pdr);
});

test.serial('The correct output is returned when granules are queued with a PDR', async (t) => {
  const dataType = `data-type-${randomString().slice(0, 6)}`;
  const version = '6';
  const collectionConfig = { foo: 'bar' };
  await t.context.collectionConfigStore.put(dataType, version, collectionConfig);

  const { event } = t.context;
  event.input.granules = [
    {
      dataType, version, granuleId: randomString(), files: [],
    },
    {
      dataType, version, granuleId: randomString(), files: [],
    },
  ];
  event.input.pdr = { name: randomString(), path: randomString() };

  await validateConfig(t, event.config);
  await validateInput(t, event.input);

  const output = await queueGranules(event);

  await validateOutput(t, output);
  t.is(output.running.length, 2);
  t.deepEqual(output.pdr, event.input.pdr);
});

test.serial('The correct output is returned when no granules are queued', async (t) => {
  const dataType = `data-type-${randomString().slice(0, 6)}`;
  const version = '6';
  const collectionConfig = { foo: 'bar' };
  await t.context.collectionConfigStore.put(dataType, version, collectionConfig);

  const { event } = t.context;
  event.input.granules = [];

  await validateConfig(t, event.config);
  await validateInput(t, event.input);

  const output = await queueGranules(event);

  await validateOutput(t, output);
  t.is(output.running.length, 0);
});

test.serial('Granules are added to the queue', async (t) => {
  const dataType = `data-type-${randomString().slice(0, 6)}`;
  const version = '6';
  const collectionConfig = { foo: 'bar' };
  await t.context.collectionConfigStore.put(dataType, version, collectionConfig);

  const { event } = t.context;
  event.input.granules = [
    {
      dataType, version, granuleId: randomString(), files: [],
    },
    {
      dataType, version, granuleId: randomString(), files: [],
    },
  ];

  await validateConfig(t, event.config);
  await validateInput(t, event.input);

  const output = await queueGranules(event);

  await validateOutput(t, output);

  // Get messages from the queue
  const receiveMessageResponse = await sqs().receiveMessage({
    QueueUrl: t.context.event.config.queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
  }).promise();
  const messages = receiveMessageResponse.Messages;

  t.is(messages.length, 2);
});

test.serial('The correct message is enqueued without a PDR', async (t) => {
  const {
    collectionConfigStore,
    event,
    queueUrl,
    queueExecutionLimits,
    stateMachineArn,
    workflow,
  } = t.context;

  const granule1 = {
    dataType: `data-type-${randomString().slice(0, 6)}`,
    version: '6',
    granuleId: `granule-${randomString().slice(0, 6)}`,
    files: [{ name: `file-${randomString().slice(0, 6)}` }],
  };
  const collectionConfig1 = { name: `collection-config-${randomString().slice(0, 6)}` };

  const granule2 = {
    dataType: `data-type-${randomString().slice(0, 6)}`,
    version: '6',
    granuleId: `granule-${randomString().slice(0, 6)}`,
    files: [{ name: `file-${randomString().slice(0, 6)}` }],
  };
  const collectionConfig2 = { name: `collection-config-${randomString().slice(0, 6)}` };

  event.input.granules = [granule1, granule2];

  await Promise.all([
    collectionConfigStore.put(granule1.dataType, granule1.version, collectionConfig1),
    collectionConfigStore.put(granule2.dataType, granule2.version, collectionConfig2),
  ]);

  await validateConfig(t, event.config);
  await validateInput(t, event.input);

  const output = await queueGranules(event);

  await validateOutput(t, output);

  // Get messages from the queue
  const receiveMessageResponse = await sqs().receiveMessage({
    QueueUrl: event.config.queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
  }).promise();
  const messages = receiveMessageResponse.Messages.map((message) => JSON.parse(message.Body));

  t.is(messages.length, 2);

  const message1 = messages.find((message) =>
    message.payload.granules[0].granuleId === granule1.granuleId);

  t.truthy(message1);
  t.deepEqual(
    message1,
    {
      cumulus_meta: {
        queueUrl,
        queueExecutionLimits,
        // The execution name is randomly generated, so we don't care what the value is here
        execution_name: message1.cumulus_meta.execution_name,
        state_machine: stateMachineArn,
      },
      meta: {
        collection: collectionConfig1,
        provider: { name: 'provider-name' },
        workflow_name: workflow,
      },
      payload: {
        granules: [
          {
            dataType: granule1.dataType,
            granuleId: granule1.granuleId,
            files: granule1.files,
            version: granule1.version,
          },
        ],
      },
    }
  );

  const message2 = messages.find((message) =>
    message.payload.granules[0].granuleId === granule2.granuleId);
  t.truthy(message2);
  t.deepEqual(
    message2,
    {
      cumulus_meta: {
        queueUrl,
        queueExecutionLimits,
        // The execution name is randomly generated, so we don't care what the value is here
        execution_name: message2.cumulus_meta.execution_name,
        state_machine: stateMachineArn,
      },
      meta: {
        collection: collectionConfig2,
        provider: { name: 'provider-name' },
        workflow_name: workflow,
      },
      payload: {
        granules: [
          {
            dataType: granule2.dataType,
            granuleId: granule2.granuleId,
            files: granule2.files,
            version: granule2.version,
          },
        ],
      },
    }
  );
});

test.serial('The correct message is enqueued with a PDR', async (t) => {
  const {
    collectionConfigStore,
    event,
    queueUrl,
    queueExecutionLimits,
    stateMachineArn,
    workflow,
  } = t.context;

  // if the event.cumulus_config has 'state_machine' and 'execution_name', the enqueued message
  // will have 'parentExecutionArn'
  event.cumulus_config = { state_machine: randomString(), execution_name: randomString() };

  const arn = buildExecutionArn(
    event.cumulus_config.state_machine, event.cumulus_config.execution_name
  );

  const pdrName = `pdr-name-${randomString()}`;
  const pdrPath = `pdr-path-${randomString()}`;
  event.input.pdr = { name: pdrName, path: pdrPath };

  const granule1 = {
    dataType: `data-type-${randomString().slice(0, 6)}`,
    version: '6',
    granuleId: `granule-${randomString().slice(0, 6)}`,
    files: [{ name: `file-${randomString().slice(0, 6)}` }],
  };
  const collectionConfig1 = { name: `collection-config-${randomString().slice(0, 6)}` };

  const granule2 = {
    dataType: `data-type-${randomString().slice(0, 6)}`,
    version: '6',
    granuleId: `granule-${randomString().slice(0, 6)}`,
    files: [{ name: `file-${randomString().slice(0, 6)}` }],
  };
  const collectionConfig2 = { name: `collection-config-${randomString().slice(0, 6)}` };

  event.input.granules = [granule1, granule2];

  await Promise.all([
    collectionConfigStore.put(granule1.dataType, granule1.version, collectionConfig1),
    collectionConfigStore.put(granule2.dataType, granule2.version, collectionConfig2),
  ]);

  await validateConfig(t, event.config);
  await validateInput(t, event.input);

  const output = await queueGranules(event);

  await validateOutput(t, output);

  // Get messages from the queue
  const receiveMessageResponse = await sqs().receiveMessage({
    QueueUrl: event.config.queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
  }).promise();
  const messages = receiveMessageResponse.Messages.map((message) => JSON.parse(message.Body));

  t.is(messages.length, 2);

  const message1 = messages.find((message) =>
    message.payload.granules[0].granuleId === granule1.granuleId);

  t.truthy(message1);
  t.deepEqual(
    message1,
    {
      cumulus_meta: {
        queueUrl,
        queueExecutionLimits,
        // The execution name is randomly generated, so we don't care what the value is here
        execution_name: message1.cumulus_meta.execution_name,
        parentExecutionArn: arn,
        state_machine: stateMachineArn,
      },
      meta: {
        pdr: event.input.pdr,
        collection: collectionConfig1,
        provider: { name: 'provider-name' },
        workflow_name: workflow,
      },
      payload: {
        granules: [
          {
            dataType: granule1.dataType,
            granuleId: granule1.granuleId,
            files: granule1.files,
            version: granule1.version,
          },
        ],
      },
    }
  );

  const message2 = messages.find((message) =>
    message.payload.granules[0].granuleId === granule2.granuleId);
  t.truthy(message2);
  t.deepEqual(
    message2,
    {
      cumulus_meta: {
        queueUrl,
        queueExecutionLimits,
        // The execution name is randomly generated, so we don't care what the value is here
        execution_name: message2.cumulus_meta.execution_name,
        parentExecutionArn: arn,
        state_machine: stateMachineArn,
      },
      meta: {
        pdr: event.input.pdr,
        collection: collectionConfig2,
        provider: { name: 'provider-name' },
        workflow_name: workflow,
      },
      payload: {
        granules: [
          {
            dataType: granule2.dataType,
            granuleId: granule2.granuleId,
            files: granule2.files,
            version: granule2.version,
          },
        ],
      },
    }
  );
});

test.serial('If a granule has a provider property, that provider is used', async (t) => {
  const dataType = randomString();
  const version = randomString();
  const collectionConfig = { foo: 'bar' };
  await t.context.collectionConfigStore.put(dataType, version, collectionConfig);

  const provider = { host: randomString() };

  const { event } = t.context;

  event.input.granules = [
    {
      dataType,
      version,
      provider,
      granuleId: randomString(),
      files: [],
    },
  ];

  await validateConfig(t, event.config);
  await validateInput(t, event.input);

  const output = await queueGranules(event);

  await validateOutput(t, output);

  // Get messages from the queue
  const { Messages } = await sqs().receiveMessage({
    QueueUrl: t.context.event.config.queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
  }).promise();

  t.is(Messages.length, 1);

  const parsedBody = JSON.parse(Messages[0].Body);

  t.deepEqual(parsedBody.meta.provider, provider);
});

test.serial('A default concurrency of 3 is used', async (t) => {
  const dataType = `data-type-${randomString().slice(0, 6)}`;
  const version = '6';
  const collectionConfig = { foo: 'bar' };
  await t.context.collectionConfigStore.put(dataType, version, collectionConfig);

  const { event } = t.context;
  event.input.granules = [
    {
      dataType, version, granuleId: randomString(), files: [],
    },
    {
      dataType, version, granuleId: randomString(), files: [],
    },
  ];

  await queueGranules(event);

  t.true(pMapSpy.calledOnce);
  t.true(pMapSpy.calledWithMatch(
    sinon.match.any,
    sinon.match.any,
    sinon.match({ concurrency: 3 })
  ));
});

test.serial('A configured concurrency is used', async (t) => {
  const dataType = `data-type-${randomString().slice(0, 6)}`;
  const version = '6';
  const collectionConfig = { foo: 'bar' };
  await t.context.collectionConfigStore.put(dataType, version, collectionConfig);

  const { event } = t.context;

  event.config.concurrency = 99;

  event.input.granules = [
    {
      dataType, version, granuleId: randomString(), files: [],
    },
    {
      dataType, version, granuleId: randomString(), files: [],
    },
  ];

  await queueGranules(event);

  t.true(pMapSpy.calledOnce);
  t.true(pMapSpy.calledWithMatch(
    sinon.match.any,
    sinon.match.any,
    sinon.match({ concurrency: 99 })
  ));
});

test.serial('A config with executionNamePrefix is handled as expected', async (t) => {
  const { event } = t.context;

  const dataType = `data-type-${randomString().slice(0, 6)}`;
  const version = '6';
  const collectionConfig = { foo: 'bar' };
  await t.context.collectionConfigStore.put(dataType, version, collectionConfig);

  const executionNamePrefix = randomString(3);
  event.config.executionNamePrefix = executionNamePrefix;

  event.input.granules = [
    {
      dataType,
      version,
      granuleId: randomString(),
      files: [],
    },
  ];

  await validateConfig(t, event.config);
  await validateInput(t, event.input);

  const output = await queueGranules(event);

  await validateOutput(t, output);

  // Get messages from the queue
  const receiveMessageResponse = await sqs().receiveMessage({
    QueueUrl: t.context.event.config.queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
  }).promise();

  const messages = receiveMessageResponse.Messages;

  t.is(messages.length, 1);

  const message = JSON.parse(messages[0].Body);

  t.true(
    message.cumulus_meta.execution_name.startsWith(executionNamePrefix),
    `Expected "${message.cumulus_meta.execution_name}" to start with "${executionNamePrefix}"`
  );

  // Make sure that the execution name isn't _just_ the prefix
  t.true(
    message.cumulus_meta.execution_name.length > executionNamePrefix.length
  );
});
