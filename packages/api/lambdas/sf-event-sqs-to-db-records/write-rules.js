'use strict';

const AggregateError = require('aggregate-error');

const log = require('@cumulus/common/log');
const {
  tableNames,
} = require('@cumulus/db');
const {
  getMessageRules,
} = require('@cumulus/message/Rules');

const Rule = require('../../models/rules');

const writeRuleViaTransaction = async ({
  rule,
  trx,
}) =>
  trx(tableNames.rules)
    .insert({
      name: rule.name,
    });

/**
 * Write a rule to DynamoDB and Postgres
 *
 * @param {Object} params
 * @param {Object} params.rule - An API Rule object
 * @param {Object} params.cumulusMessage - A workflow message
 * @param {Knex} params.knex - Client to interact with Postgres database
 * @param {Object} [params.ruleModel]
 *   Optional override for the rule model writing to DynamoDB
 *
 * @returns {Promise}
 * @throws
 */
const writeRule = async ({
  rule,
  knex,
  ruleModel,
}) =>
  knex.transaction(async (trx) => {
    await writeRuleViaTransaction({
      rule,
      trx,
    });
    return ruleModel.storeRuleFromCumulusMessage(rule);
  });

/**
 * Write rules to DynamoDB and Postgres
 *
 * @param {Object} params
 * @param {Object} params.cumulusMessage - A workflow message
 * @param {string} params.collectionCumulusId
 *   Cumulus ID for collection referenced in workflow message, if any
 * @param {Knex} params.knex - Client to interact with Postgres database
 * @param {string} [params.providerCumulusId]
 *   Cumulus ID for provider referenced in workflow message, if any
 * @param {Object} [params.ruleModel]
 *   Optional override for the rule model writing to DynamoDB
 *
 * @returns {Promise<Object[]>}
 *  true if there are no rules on the message, otherwise
 *  results from Promise.allSettled for all rules
 * @throws {Error} - if no collection or provider is provided
 */
const writeRules = async ({
  cumulusMessage,
  knex,
  ruleModel = new Rule(),
}) => {
  const rules = getMessageRules(cumulusMessage);

  // Process each rule in a separate transaction via Promise.allSettled
  // so that they can succeed/fail independently
  const results = await Promise.allSettled(rules.map(
    (rule) => writeRule({
      rule,
      cumulusMessage,
      knex,
      ruleModel,
    })
  ));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    const allFailures = failures.map((failure) => failure.reason);
    const aggregateError = new AggregateError(allFailures);
    log.error('Failed writing some rules to Dynamo', aggregateError);
    throw aggregateError;
  }
  return results;
};

module.exports = {
  writeRuleViaTransaction,
  writeRules,
};
