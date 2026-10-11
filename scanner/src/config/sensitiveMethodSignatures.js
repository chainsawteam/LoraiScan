const ENTRY_METHODS = [
  'stake',
  'stakeFor',
  'stakeETH',
  'stakeToken',
  'deposit',
  'depositFor',
  'depositETH',
  'depositToken',
  'invest',
  'subscribe',
  'pledge',
  'lock',
  'lockTokens',
  'lockETH',
  'bond',
  'enter',
  'join',
  'contribute',
  'participate',
  'buy',
  'purchase'
];

const ENTRY_ARGS = [
  '',
  'address',
  'uint256',
  'uint256,uint256',
  'uint256,uint256,uint256',
  'address,uint256',
  'uint256,address',
  'address,uint256,address',
  'uint256,address,address',
  'address,address,uint256',
  'address,uint256,uint256',
  'uint256,address,uint256',
  'uint256,uint256,address',
  'uint256,uint256,address,address',
  'uint256,uint256,uint256,address',
  'uint256,bool',
  'address,uint256,bool',
  'uint256,address,bool',
  'uint256,uint256,bool',
  'uint256,bytes',
  'address,uint256,bytes',
  'uint256,address,bytes',
  'uint256,uint256,bytes',
  'bytes32',
  'bytes32,uint256',
  'bytes32,address',
  'bytes32,address,uint256',
  'bytes32,uint256,address',
  'uint256[]',
  'address[]',
  'uint256[],address',
  'address,uint256[]',
  'address[],uint256[]'
];

const MIGRATION_METHODS = [
  'migrate',
  'migrateTo',
  'migrateFrom',
  'migrateStake',
  'migrateLiquidity',
  'moveStake',
  'convert',
  'upgrade',
  'upgradeTo',
  'upgradeToAndCall'
];

const MIGRATION_ARGS = [
  '',
  'address',
  'uint256',
  'address,uint256',
  'uint256,address',
  'address,address',
  'address,address,uint256',
  'address,uint256,address',
  'uint256,address,address',
  'uint256,uint256',
  'uint256,uint256,address',
  'bytes',
  'bytes32',
  'address,bytes',
  'address,bytes,bool',
  'address,uint256,bytes',
  'uint256,address,bytes',
  'bytes32,address',
  'bytes32,address,uint256',
  'uint256[]',
  'address[]'
];

const SETTER_METHODS = [
  'setOwner',
  'transferOwnership',
  'setAdmin',
  'changeAdmin',
  'setOperator',
  'setSigner',
  'setTreasury',
  'setVault',
  'setStrategy',
  'setPool',
  'setRouter',
  'setImplementation',
  'setProxy'
];

const SETTER_ARGS = [
  'address',
  'address,bool',
  'address,uint256',
  'uint256,address',
  'address,address',
  'bytes32,address',
  'bytes32,address,bool',
  'uint256',
  'bytes32',
  'string',
  'string,address',
  'address,bytes',
  'address,uint256,bool'
];

const ROLE_METHODS = [
  'grantRole',
  'revokeRole'
];

const ROLE_ARGS = [
  'bytes32,address',
  'bytes32,address,address',
  'bytes32,address,bool',
  'uint256,address',
  'uint256,address,bool',
  'uint8,address',
  'address',
  'address,uint256'
];

const NO_ARG_ADMIN_METHODS = [
  'acceptOwnership',
  'renounceOwnership',
  'pause',
  'unpause'
];

const NO_ARG_ADMIN_ARGS = [
  '',
  'address',
  'uint256',
  'bytes32'
];

function expand(methods, argLists) {
  const signatures = [];
  for (const method of methods) {
    for (const args of argLists) {
      signatures.push(`${method}(${args})`);
    }
  }
  return signatures;
}

function defaultSensitiveMethodSignatures() {
  return [...new Set([
    ...expand(ENTRY_METHODS, ENTRY_ARGS),
    ...expand(MIGRATION_METHODS, MIGRATION_ARGS),
    ...expand(SETTER_METHODS, SETTER_ARGS),
    ...expand(ROLE_METHODS, ROLE_ARGS),
    ...expand(NO_ARG_ADMIN_METHODS, NO_ARG_ADMIN_ARGS)
  ])];
}

module.exports = {
  defaultSensitiveMethodSignatures
};
