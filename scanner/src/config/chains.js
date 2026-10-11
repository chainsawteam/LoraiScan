const HOURS = 60 * 60 * 1000;
const { defaultSensitiveMethodSignatures } = require('./sensitiveMethodSignatures');

const ROBIN_FLAP_MINIMAL_PROXY_BYTECODE = '0x363d3d373d3d3d363d737777c8743c88b3aff3cf262135bef2c8b2e833335af43d82803e903d91602b57fd5bf3';
const ROBIN_PONS_TOKEN_BYTECODE = '0x60806040526004361015610011575f80fd5b5f3560e01c806306fdde03146106b1578063095ea7b31461060957806318160ddd146105ec57806323b872dd146105b4578063313ce5671461059957806342966c681461057c578063536dac9b1461053857806353cd512a146104ac57806370a08231146104755780637165485d146104315780637284e4161461041657806379cc6790146103e457806395d89b41146102f0578063a9059cbb146102bf578063abb1dc44146101aa578063d5f3948814610166578063dd62ed3e146101165763fb7f21eb146100df575f80fd5b34610112575f3660031901126101125761010e6100fa6108dc565b60405191829160208352602083019061076c565b0390f35b5f80fd5b346101125760403660031901126101125761012f610790565b6101376107a6565b6001600160a01b039182165f908152600160209081526040808320949093168252928352819020549051908152f35b34610112575f366003190112610112576040517f000000000000000000000000bd1bd939b00810d1849119bb4b011ba67867987f6001600160a01b03168152602090f35b34610112575f36600319011261011257606060806040516101ca816107bc565b828152826020820152826040820152828082015201526102446101eb6108dc565b61010e6101f661080e565b610252610201610a3e565b9160405195869560018060a01b037f000000000000000000000000bd1bd939b00810d1849119bb4b011ba67867987f16875260806020880152608087019061076c565b90858203604087015261076c565b838103606085015260806102ae61029c61028a610278865160a0875260a087019061076c565b6020870151868203602088015261076c565b6040860151858203604087015261076c565b6060850151848203606086015261076c565b92015190608081840391015261076c565b34610112576040366003190112610112576102e56102db610790565b6024359033610b39565b602060405160018152f35b34610112575f366003190112610112576040515f6004548060011c906001811680156103da575b6020831081146103c6578285529081156103a25750600114610344575b61010e836100fa818503826107ec565b60045f9081527f8a35acfbc15ff81a39ae7d344fd709f28e8600b4aa8c65c6b64bfe7fe36bd19b939250905b808210610388575090915081016020016100fa610334565b919260018160209254838588010152019101909291610370565b60ff191660208086019190915291151560051b840190910191506100fa9050610334565b634e487b7160e01b5f52602260045260245ffd5b91607f1691610317565b3461011257604036600319011261011257610414610400610790565b6024359061040f823383610a96565b610bf6565b005b34610112575f3660031901126101125761010e6100fa61080e565b34610112575f366003190112610112576040517f0000000000000000000000001e9f9eb787e14f989c2606988c8c0f200ad97b616001600160a01b03168152602090f35b34610112576020366003190112610112576001600160a01b03610496610790565b165f525f602052602060405f2054604051908152f35b34610112575f366003190112610112576105006104c7610a3e565b61010e81519161052a60208201519161051c604082015161050e6080606085015194015195604051998a9960a08b5260a08b019061076c565b9089820360208b015261076c565b90878203604089015261076c565b90858203606087015261076c565b90838203608085015261076c565b34610112575f366003190112610112576040517f0000000000000000000000007ed598bcef8bd9edd8c97a195c6d13f40801ec7e6001600160a01b03168152602090f35b346101125760203660031901126101125761041460043533610bf6565b34610112575f36600319011261011257602060405160128152f35b34610112576060366003190112610112576102e56105d0610790565b6105d86107a6565b604435916105e7833383610a96565b610b39565b34610112575f366003190112610112576020600254604051908152f35b3461011257604036600319011261011257610622610790565b60243590331561069e576001600160a01b031690811561068b57335f52600160205260405f20825f526020528060405f20556040519081527f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b92560203392a3602060405160018152f35b634a1406b160e11b5f525f60045260245ffd5b63e602df0560e01b5f525f60045260245ffd5b34610112575f366003190112610112576040515f6003548060011c90600181168015610762575b6020831081146103c6578285529081156103a257506001146107045761010e836100fa818503826107ec565b60035f90815290917fc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b939250905b808210610748575090915081016020016100fa610334565b919260018160209254838588010152019101909291610730565b91607f16916106d8565b805180835260209291819084018484015e5f828201840152601f01601f1916010190565b600435906001600160a01b038216820361011257565b602435906001600160a01b038216820361011257565b60a0810190811067ffffffffffffffff8211176107d857604052565b634e487b7160e01b5f52604160045260245ffd5b90601f8019910116810190811067ffffffffffffffff8211176107d857604052565b604051905f6006548060011c91600182169182156108d2575b6020841083146103c65783865285929081156108b35750600114610854575b610852925003836107ec565b565b5060065f90815290917ff652222313e28459528d920b65115c16c04f3efc82aaedc97be59f3f377c0d3f5b81831061089757505090602061085292820101610846565b602091935080600191548385890101520191019091849261087f565b6020925061085294915060ff191682840152151560051b820101610846565b92607f1692610827565b604051905f6005548060011c916001821691821561097e575b6020841083146103c65783865285929081156108b3575060011461091f57610852925003836107ec565b5060055f90815290917f036b6384b5eca791c62761152d0c79bb0604c104a5fb6f4eb0703f3154bb3db05b81831061096257505090602061085292820101610846565b602091935080600191548385890101520191019091849261094a565b92607f16926108f5565b90604051915f8154908160011c9260018316928315610a34575b6020851084146103c6578487528693908115610a1257506001146109ce575b50610852925003836107ec565b90505f9291925260205f20905f915b8183106109f6575050906020610852928201015f6109c1565b60209193508060019154838589010152019101909184926109dd565b90506020925061085294915060ff191682840152151560051b8201015f6109c1565b93607f16936109a2565b60405190610a4b826107bc565b81610a566007610988565b8152610a626008610988565b6020820152610a716009610988565b6040820152610a80600a610988565b60608201526080610a91600b610988565b910152565b6001600160a01b039081165f818152600160209081526040808320948616835293905291909120549291905f198410610ad0575b50505050565b828410610b1657801561069e576001600160a01b0382161561068b575f52600160205260405f209060018060a01b03165f5260205260405f20910390555f808080610aca565b508290637dc7a0d960e11b5f5260018060a01b031660045260245260445260645ffd5b6001600160a01b0316908115610be3576001600160a01b0316918215610bd057815f525f60205260405f2054818110610bb757817fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef92602092855f525f84520360405f2055845f525f825260405f20818154019055604051908152a3565b8263391434e360e21b5f5260045260245260445260645ffd5b63ec442f0560e01b5f525f60045260245ffd5b634b637e8f60e11b5f525f60045260245ffd5b9091906001600160a01b03168015610be357805f525f60205260405f2054838110610c60576020845f94957fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef938587528684520360408620558060025403600255604051908152a3565b915063391434e360e21b5f5260045260245260445260645ffdfea2646970667358221220f8f8df1aef409554acec1774e66d855cbdc94f6a3e199a378f5ba9fe2a08326664736f6c63430008230033';
const ROBIN_UNISWAP_V4_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

function parseList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseLowerList(value) {
  return parseList(value).map(item => item.toLowerCase());
}

function parseMethodList(value) {
  return parseList(value).map(item => {
    const [selectorPart, namePart] = item.split(':');
    return {
      selector: String(selectorPart || '').trim().toLowerCase(),
      name: String(namePart || selectorPart || '').trim()
    };
  });
}

function parseMethodSignatureList(value) {
  return [...new Set(parseList(value).map(item => String(item || '').trim()).filter(Boolean))];
}

function parseQuoteTokenList(value) {
  return parseList(value).map(item => {
    const [address, symbol, decimals, priceUsd] = item.split(':');
    return {
      address: String(address || '').trim().toLowerCase(),
      symbol: String(symbol || address || '').trim(),
      decimals: parseInt(decimals || '18', 10),
      priceUsd: parseFloat(priceUsd || '1')
    };
  }).filter(item => /^0x[a-f0-9]{40}$/.test(item.address));
}

function parseNumberList(value) {
  return parseList(value)
    .map(item => parseInt(item, 10))
    .filter(item => Number.isFinite(item) && item > 0);
}

function normalizeBytecode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  return normalized.startsWith('0x') ? normalized : `0x${normalized}`;
}

function parseBytecodeFilterRules(value) {
  return parseList(value).map(item => {
    const raw = String(item || '').trim();
    const separatorIndex = raw.indexOf(':');
    const hasSuffix = separatorIndex > 0 && !raw.slice(0, separatorIndex).startsWith('0x');
    const addressSuffix = hasSuffix ? raw.slice(0, separatorIndex).trim().toLowerCase().replace(/^0x/, '') : '';
    const bytecode = normalizeBytecode(hasSuffix ? raw.slice(separatorIndex + 1) : raw);
    return {
      addressSuffix,
      bytecode,
      reason: addressSuffix ? `bytecode_suffix_${addressSuffix}` : 'bytecode_exact'
    };
  }).filter(item => /^0x[a-f0-9]+$/.test(item.bytecode));
}

function parseContractValueAssetList(value) {
  return parseList(value).map(item => {
    const [address, symbol, decimals, priceUsd, minAmount, minValueUsd] = item.split(':');
    const priceValue = String(priceUsd || '1').trim().toLowerCase();
    return {
      address: String(address || '').trim().toLowerCase(),
      symbol: String(symbol || address || '').trim(),
      decimals: parseInt(decimals || '18', 10),
      priceUsd: priceValue === 'native' ? 0 : parseFloat(priceUsd || '1'),
      nativePriced: priceValue === 'native',
      minAmount: parseFloat(minAmount || '0'),
      minValueUsd: parseFloat(minValueUsd || '0')
    };
  }).filter(item => /^0x[a-f0-9]{40}$/.test(item.address));
}

function defaultBytecodeFilterRules(chainKey) {
  if (chainKey === 'ROBIN') {
    return [
      {
        addressSuffix: '7777',
        bytecode: ROBIN_FLAP_MINIMAL_PROXY_BYTECODE,
        reason: 'robin_flap_suffix_7777_bytecode'
      },
      {
        addressSuffix: '',
        bytecode: ROBIN_PONS_TOKEN_BYTECODE,
        reason: 'robin_pons_bytecode'
      }
    ];
  }

  return [];
}

function defaultFactoryV3Fees(chainKey) {
  if (chainKey === 'ROBIN') {
    return [100, 500, 3000, 10000];
  }
  return [];
}

function defaultUniV2Factory(chainKey) {
  if (chainKey === 'ETH') {
    return '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
  }
  if (chainKey === 'BASE') {
    return '0x8909dc15e40173ff4699343b6eb8132c65e18ec6';
  }
  if (chainKey === 'BSC') {
    return '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
  }
  if (chainKey === 'ARB') {
    return '0x1F98431c8aD98523631AE4a59f267346ea31F984';
  }

  return '';
}

function defaultDiscoveryProtocol(chainKey) {
  return chainKey === 'ARB' ? 'uniswap-v3' : 'uniswap-v2';
}

function defaultDiscoveryFactory(chainKey, protocol) {
  if (chainKey === 'ETH' && protocol === 'uniswap-v3') {
    return '0x1F98431c8aD98523631AE4a59f267346ea31F984';
  }
  if (chainKey === 'BASE' && protocol === 'uniswap-v3') {
    return '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
  }
  if (chainKey === 'BSC' && protocol === 'uniswap-v3') {
    return '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
  }

  return defaultUniV2Factory(chainKey);
}

function defaultDiscoveryFromBlock(chainKey, protocol) {
  if (chainKey === 'ETH' && protocol === 'uniswap-v2') {
    return 10000835;
  }
  if (chainKey === 'ETH' && protocol === 'uniswap-v3') {
    return 12369621;
  }
  if (chainKey === 'BASE') {
    return 'latest';
  }
  if (chainKey === 'BSC' && protocol === 'uniswap-v2') {
    return 6809737;
  }
  if (chainKey === 'BSC' && protocol === 'uniswap-v3') {
    return 26956207;
  }
  if (chainKey === 'ARB' && protocol === 'uniswap-v3') {
    return 1;
  }

  return 0;
}

function defaultDiscoverySourceKey(chainKey, protocol) {
  if (chainKey === 'BSC') {
    return 'bsc-pancakeswap-v2';
  }
  if (chainKey === 'ETH') {
    return protocol === 'uniswap-v3' ? 'eth-uniswap-v3' : 'eth-uniswap-v2';
  }
  if (chainKey === 'BASE') {
    return protocol === 'uniswap-v3' ? 'base-uniswap-v3' : 'base-uniswap-v2';
  }
  if (chainKey === 'ARB') {
    return 'arb-uniswap-v3';
  }

  return `${chainKey.toLowerCase()}-${protocol}`;
}

function defaultMethodCallQuoteTokens(chainKey) {
  if (chainKey === 'ETH') {
    return [
      { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18, nativePriced: true },
      { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6, priceUsd: 1 },
      { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, priceUsd: 1 },
      { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', decimals: 18, priceUsd: 1 }
    ];
  }
  if (chainKey === 'BSC') {
    return [
      { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18, nativePriced: true },
      { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18, priceUsd: 1 },
      { address: '0xe9e7cea3dedca5984780bafc599bd69add087d56', symbol: 'BUSD', decimals: 18, priceUsd: 1 },
      { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18, priceUsd: 1 }
    ];
  }
  if (chainKey === 'BASE') {
    return [
      { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, nativePriced: true },
      { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6, priceUsd: 1 },
      { address: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', symbol: 'USDbC', decimals: 6, priceUsd: 1 },
      { address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', symbol: 'DAI', decimals: 18, priceUsd: 1 }
    ];
  }
  if (chainKey === 'ARB') {
    return [
      { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', symbol: 'WETH', decimals: 18, nativePriced: true },
      { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6, priceUsd: 1 },
      { address: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', symbol: 'USDC.e', decimals: 6, priceUsd: 1 },
      { address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', symbol: 'USDT', decimals: 6, priceUsd: 1 },
      { address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', symbol: 'DAI', decimals: 18, priceUsd: 1 }
    ];
  }
  if (chainKey === 'ROBIN') {
    return [
      { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', symbol: 'WETH', decimals: 18, nativePriced: true },
      { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6, priceUsd: 1 }
    ];
  }

  return [];
}

function defaultContractValueMonitorAssets(chainKey) {
  if (chainKey === 'BSC') {
    return [
      { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18, nativePriced: true, minAmount: 100, minValueUsd: 0 },
      { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18, priceUsd: 1, minAmount: 0, minValueUsd: 0 },
      { address: '0xe9e7cea3dedca5984780bafc599bd69add087d56', symbol: 'BUSD', decimals: 18, priceUsd: 1, minAmount: 0, minValueUsd: 0 },
      { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18, priceUsd: 1, minAmount: 0, minValueUsd: 0 }
    ];
  }

  return [];
}

function defaultContractValueDenylist(chainKey) {
  if (chainKey === 'BSC') {
    return [
      '0x0000000000000000000000000000000000001000',
      '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
      '0x55d398326f99059ff775485246999027b3197955',
      '0xe9e7cea3dedca5984780bafc599bd69add087d56',
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
      '0x10ed43c718714eb63d5aa57b78b54704e256024e',
      '0xca143ce32fe78f1f7019d7d551a6402fc5350c73',
      '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
      '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',
      '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364'
    ];
  }

  return [];
}

function defaultMethodCallDenylist(chainKey) {
  return [
    ...defaultContractValueDenylist(chainKey),
    ...defaultMethodCallQuoteTokens(chainKey).map(token => token.address)
  ].filter(Boolean).map(address => String(address).toLowerCase());
}

function defaultNativeAssetConfig(chainKey, prefix) {
  if (chainKey === 'ETH') {
    return {
      symbol: 'ETH',
      decimals: 18,
      wrappedAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      chainlinkFeedAddress: process.env[`${prefix}METHOD_CALL_NATIVE_CHAINLINK_FEED`] || process.env.METHOD_CALL_NATIVE_CHAINLINK_FEED || '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
      fallbackPriceUsd: parseFloat(process.env[`${prefix}METHOD_CALL_NATIVE_USD_PRICE`] || process.env.METHOD_CALL_NATIVE_USD_PRICE || '0'),
      priceTtlMs: parseInt(process.env[`${prefix}METHOD_CALL_NATIVE_PRICE_TTL_MS`] || process.env.METHOD_CALL_NATIVE_PRICE_TTL_MS || String(5 * 60 * 1000), 10)
    };
  }
  if (chainKey === 'BSC') {
    return {
      symbol: 'BNB',
      decimals: 18,
      wrappedAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
      priceFactoryAddress: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
      priceTokenAddress: '0x55d398326f99059ff775485246999027b3197955',
      priceTokenDecimals: 18,
      fallbackPriceUsd: parseFloat(process.env[`${prefix}METHOD_CALL_NATIVE_USD_PRICE`] || process.env.METHOD_CALL_NATIVE_USD_PRICE || '0'),
      priceTtlMs: parseInt(process.env[`${prefix}METHOD_CALL_NATIVE_PRICE_TTL_MS`] || process.env.METHOD_CALL_NATIVE_PRICE_TTL_MS || String(5 * 60 * 1000), 10)
    };
  }
  if (chainKey === 'BASE') {
    return {
      symbol: 'ETH',
      decimals: 18,
      wrappedAddress: '0x4200000000000000000000000000000000000006',
      chainlinkFeedAddress: process.env[`${prefix}METHOD_CALL_NATIVE_CHAINLINK_FEED`] || process.env.METHOD_CALL_NATIVE_CHAINLINK_FEED || '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70F',
      fallbackPriceUsd: parseFloat(process.env[`${prefix}METHOD_CALL_NATIVE_USD_PRICE`] || process.env.METHOD_CALL_NATIVE_USD_PRICE || '0'),
      priceTtlMs: parseInt(process.env[`${prefix}METHOD_CALL_NATIVE_PRICE_TTL_MS`] || process.env.METHOD_CALL_NATIVE_PRICE_TTL_MS || String(5 * 60 * 1000), 10)
    };
  }
  if (chainKey === 'ARB') {
    return {
      symbol: 'ETH',
      decimals: 18,
      wrappedAddress: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
      chainlinkFeedAddress: process.env[`${prefix}METHOD_CALL_NATIVE_CHAINLINK_FEED`] || process.env.METHOD_CALL_NATIVE_CHAINLINK_FEED || '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
      fallbackPriceUsd: parseFloat(process.env[`${prefix}METHOD_CALL_NATIVE_USD_PRICE`] || process.env.METHOD_CALL_NATIVE_USD_PRICE || '0'),
      priceTtlMs: parseInt(process.env[`${prefix}METHOD_CALL_NATIVE_PRICE_TTL_MS`] || process.env.METHOD_CALL_NATIVE_PRICE_TTL_MS || String(5 * 60 * 1000), 10)
    };
  }
  if (chainKey === 'ROBIN') {
    return {
      symbol: 'ETH',
      decimals: 18,
      wrappedAddress: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
      priceFactoryAddress: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
      priceTokenAddress: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      priceTokenDecimals: 6,
      fallbackPriceUsd: parseFloat(process.env[`${prefix}METHOD_CALL_NATIVE_USD_PRICE`] || process.env.METHOD_CALL_NATIVE_USD_PRICE || '3000'),
      priceTtlMs: parseInt(process.env[`${prefix}METHOD_CALL_NATIVE_PRICE_TTL_MS`] || process.env.METHOD_CALL_NATIVE_PRICE_TTL_MS || String(5 * 60 * 1000), 10)
    };
  }

  return {
    symbol: process.env[`${prefix}METHOD_CALL_NATIVE_SYMBOL`] || process.env.METHOD_CALL_NATIVE_SYMBOL || 'NATIVE',
    decimals: parseInt(process.env[`${prefix}METHOD_CALL_NATIVE_DECIMALS`] || process.env.METHOD_CALL_NATIVE_DECIMALS || '18', 10),
    fallbackPriceUsd: parseFloat(process.env[`${prefix}METHOD_CALL_NATIVE_USD_PRICE`] || process.env.METHOD_CALL_NATIVE_USD_PRICE || '0'),
    priceTtlMs: parseInt(process.env[`${prefix}METHOD_CALL_NATIVE_PRICE_TTL_MS`] || process.env.METHOD_CALL_NATIVE_PRICE_TTL_MS || String(5 * 60 * 1000), 10)
  };
}

function defaultContractValueNativeAssetConfig(chainKey, prefix) {
  const native = defaultNativeAssetConfig(chainKey, prefix);
  if (chainKey === 'BSC') {
    return {
      ...native,
      minAmount: parseFloat(process.env[`${prefix}CONTRACT_VALUE_MONITOR_NATIVE_MIN_AMOUNT`] || process.env.CONTRACT_VALUE_MONITOR_NATIVE_MIN_AMOUNT || '100'),
      minValueUsd: parseFloat(process.env[`${prefix}CONTRACT_VALUE_MONITOR_NATIVE_MIN_VALUE_USD`] || process.env.CONTRACT_VALUE_MONITOR_NATIVE_MIN_VALUE_USD || '0')
    };
  }

  return {
    ...native,
    minAmount: parseFloat(process.env[`${prefix}CONTRACT_VALUE_MONITOR_NATIVE_MIN_AMOUNT`] || process.env.CONTRACT_VALUE_MONITOR_NATIVE_MIN_AMOUNT || '0'),
    minValueUsd: parseFloat(process.env[`${prefix}CONTRACT_VALUE_MONITOR_NATIVE_MIN_VALUE_USD`] || process.env.CONTRACT_VALUE_MONITOR_NATIVE_MIN_VALUE_USD || '0')
  };
}

function defaultDiscoveryDescriptors(chainKey, defaultEnabled) {
  const v4Descriptor = () => {
    const envPrefix = `${chainKey}_UNISWAP_V4`;
    const poolManagerAddress = process.env[`${envPrefix}_POOL_MANAGER`]
      || (chainKey === 'ROBIN' ? ROBIN_UNISWAP_V4_POOL_MANAGER : '');
    return {
      envPrefix,
      protocol: 'uniswap-v4',
      sourceKey: `${chainKey.toLowerCase()}-uniswap-v4`,
      poolManagerAddress,
      factoryAddress: poolManagerAddress,
      fromBlock: 'latest',
      enabled: envFlag(`${envPrefix}_DISCOVERY_ENABLED`, Boolean(poolManagerAddress))
    };
  };

  if (chainKey === 'BSC') {
    return [
      {
        envPrefix: 'BSC_PANCAKE_V2',
        protocol: 'uniswap-v2',
        sourceKey: 'bsc-pancakeswap-v2',
        factoryAddress: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
        fromBlock: 6809737,
        enabled: defaultEnabled
      },
      {
        envPrefix: 'BSC_PANCAKE_V3',
        protocol: 'uniswap-v3',
        sourceKey: 'bsc-pancakeswap-v3',
        factoryAddress: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
        fromBlock: 26956207,
        enabled: defaultEnabled
      },
      {
        envPrefix: 'BSC_UNISWAP_V2',
        protocol: 'uniswap-v2',
        sourceKey: 'bsc-uniswap-v2',
        factoryAddress: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
        fromBlock: 'latest',
        enabled: defaultEnabled
      },
      {
        envPrefix: 'BSC_UNISWAP_V3',
        protocol: 'uniswap-v3',
        sourceKey: 'bsc-uniswap-v3',
        factoryAddress: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
        fromBlock: 'latest',
        enabled: defaultEnabled
      },
      v4Descriptor()
    ];
  }

  if (chainKey === 'ETH') {
    return [
      {
        envPrefix: 'ETH_UNISWAP_V2',
        protocol: 'uniswap-v2',
        sourceKey: 'eth-uniswap-v2',
        factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
        fromBlock: 10000835,
        enabled: defaultEnabled
      },
      {
        envPrefix: 'ETH_UNISWAP_V3',
        protocol: 'uniswap-v3',
        sourceKey: 'eth-uniswap-v3',
        factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        fromBlock: 12369621,
        enabled: defaultEnabled
      },
      v4Descriptor()
    ];
  }

  if (chainKey === 'BASE') {
    return [
      {
        envPrefix: 'BASE_UNISWAP_V2',
        protocol: 'uniswap-v2',
        sourceKey: 'base-uniswap-v2',
        factoryAddress: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
        fromBlock: 'latest',
        enabled: defaultEnabled
      },
      {
        envPrefix: 'BASE_UNISWAP_V3',
        protocol: 'uniswap-v3',
        sourceKey: 'base-uniswap-v3',
        factoryAddress: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
        fromBlock: 'latest',
        enabled: defaultEnabled
      },
      v4Descriptor()
    ];
  }

  if (chainKey === 'ROBIN') {
    return [
      {
        envPrefix: 'ROBIN_UNISWAP_V2',
        protocol: 'uniswap-v2',
        sourceKey: 'robin-uniswap-v2',
        factoryAddress: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
        fromBlock: 'latest',
        enabled: defaultEnabled
      },
      {
        envPrefix: 'ROBIN_UNISWAP_V3',
        protocol: 'uniswap-v3',
        sourceKey: 'robin-uniswap-v3',
        factoryAddress: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
        fromBlock: 'latest',
        enabled: defaultEnabled
      },
      v4Descriptor()
    ];
  }


  const protocol = defaultDiscoveryProtocol(chainKey);
  return [
    {
      envPrefix: chainKey,
      protocol,
      sourceKey: defaultDiscoverySourceKey(chainKey, protocol),
      factoryAddress: defaultDiscoveryFactory(chainKey, protocol),
      fromBlock: defaultDiscoveryFromBlock(chainKey, protocol),
      enabled: defaultEnabled
    },
    v4Descriptor()
  ];
}

function createDiscoveryConfigs(chainKey, prefix) {
  const defaultEnabled = envFlag(`${prefix}DISCOVERY_ENABLED`, envFlag('DISCOVERY_ENABLED', false));
  const defaultSubscribeEnabled = envFlag(`${prefix}SUBSCRIBE_ENABLED`, envFlag('SUBSCRIBE_ENABLED', false));
  const defaultBackfillEnabled = envFlag(`${prefix}DISCOVERY_BACKFILL_ENABLED`, envFlag('DISCOVERY_BACKFILL_ENABLED', chainKey !== 'ROBIN'));
  const confirmations = parseInt(process.env[`${prefix}DISCOVERY_CONFIRMATIONS`] || process.env.DISCOVERY_CONFIRMATIONS || '12', 10);
  const batchBlocks = parseInt(process.env[`${prefix}DISCOVERY_BATCH_BLOCKS`] || process.env.DISCOVERY_BATCH_BLOCKS || '2000', 10);
  const subscriptionBackfillBlocks = parseInt(process.env[`${prefix}SUBSCRIPTION_BACKFILL_BLOCKS`] || process.env.SUBSCRIPTION_BACKFILL_BLOCKS || '64', 10);
  const subscriptionReconnectDelayMs = parseInt(process.env[`${prefix}SUBSCRIPTION_RECONNECT_DELAY_MS`] || process.env.SUBSCRIPTION_RECONNECT_DELAY_MS || '5000', 10);
  const ignoreTokens = parseLowerList(process.env[`${prefix}DISCOVERY_IGNORE_TOKENS`] || process.env.DISCOVERY_IGNORE_TOKENS || process.env[`${prefix}QUOTE_TOKENS`] || process.env.QUOTE_TOKENS);

  return defaultDiscoveryDescriptors(chainKey, defaultEnabled).map(descriptor => {
    const descriptorPrefix = `${descriptor.envPrefix}_`;
    const protocol = process.env[`${descriptorPrefix}DISCOVERY_PROTOCOL`]
      || process.env[`${prefix}DISCOVERY_PROTOCOL`]
      || process.env.DISCOVERY_PROTOCOL
      || descriptor.protocol;

    return {
      enabled: envFlag(`${descriptorPrefix}DISCOVERY_ENABLED`, descriptor.enabled),
      subscribeEnabled: envFlag(`${descriptorPrefix}SUBSCRIBE_ENABLED`, defaultSubscribeEnabled),
      backfillEnabled: envFlag(`${descriptorPrefix}DISCOVERY_BACKFILL_ENABLED`, defaultBackfillEnabled),
      protocol,
      sourceKey: process.env[`${descriptorPrefix}DISCOVERY_SOURCE_KEY`] || descriptor.sourceKey,
      factoryAddress: process.env[`${descriptorPrefix}DISCOVERY_FACTORY`]
        || process.env[`${descriptorPrefix}POOL_MANAGER`]
        || process.env[`${descriptorPrefix}UNISWAP_V3_FACTORY`]
        || process.env[`${descriptorPrefix}UNISWAP_V2_FACTORY`]
        || descriptor.factoryAddress,
      poolManagerAddress: process.env[`${descriptorPrefix}POOL_MANAGER`]
        || process.env[`${descriptorPrefix}DISCOVERY_FACTORY`]
        || descriptor.poolManagerAddress
        || descriptor.factoryAddress,
      stateViewAddress: process.env[`${descriptorPrefix}STATE_VIEW`] || descriptor.stateViewAddress || '',
      quoterAddress: process.env[`${descriptorPrefix}QUOTER`] || descriptor.quoterAddress || '',
      fromBlock: process.env[`${descriptorPrefix}DISCOVERY_FROM_BLOCK`]
        || process.env[`${prefix}DISCOVERY_FROM_BLOCK`]
        || process.env.DISCOVERY_FROM_BLOCK
        || descriptor.fromBlock,
      confirmations,
      batchBlocks,
      subscriptionBackfillBlocks: parseInt(process.env[`${descriptorPrefix}SUBSCRIPTION_BACKFILL_BLOCKS`] || String(subscriptionBackfillBlocks), 10),
      subscriptionReconnectDelayMs: parseInt(process.env[`${descriptorPrefix}SUBSCRIPTION_RECONNECT_DELAY_MS`] || String(subscriptionReconnectDelayMs), 10),
      ignoreTokens,
      scanDelayMs: parseInt(process.env[`${descriptorPrefix}DISCOVERY_SCAN_DELAY_MS`] || process.env[`${prefix}DISCOVERY_SCAN_DELAY_MS`] || process.env.DISCOVERY_SCAN_DELAY_MS || String(15 * 60 * 1000), 10)
    };
  });
}

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return value === '1' || value.toLowerCase() === 'true';
}

function aveScanConfig(chainKey) {
  const prefix = `${chainKey}_`;
  const discoveryProtocol = process.env[`${prefix}DISCOVERY_PROTOCOL`]
    || process.env.DISCOVERY_PROTOCOL
    || defaultDiscoveryProtocol(chainKey);
  const rpcUrl = process.env[`${prefix}LORAI_AUDIT_RPC_URL`]
    || process.env.LORAI_AUDIT_RPC_URL
    || process.env[`${prefix}WS_RPC`]
    || process.env[`${prefix}RPC`]
    || '';

  return {
    sourceType: process.env[`${prefix}SCAN_SOURCE`] || process.env.SCAN_SOURCE || 'ave_liquidity_v1',
    scanIntervalMs: parseInt(process.env[`${prefix}SCAN_INTERVAL_MS`] || process.env.GET_TOKEN_INTERVAL || String(5 * 60 * 1000), 10),
    refreshIntervalMs: parseInt(process.env[`${prefix}REFRESH_INTERVAL_MS`] || process.env.REFRESH_INTERVAL_MS || String(HOURS), 10),
    topPoolIntervalMs: parseInt(process.env[`${prefix}TOP_POOL_INTERVAL_MS`] || process.env.TOP_POOL_INTERVAL_MS || String(HOURS), 10),
    staleAfterMs: parseInt(process.env[`${prefix}STALE_AFTER_MS`] || process.env.STALE_AFTER_MS || String(12 * HOURS), 10),
    rescanIntervalMs: parseInt(process.env[`${prefix}RESCAN_INTERVAL_MS`] || process.env.RESCAN_INTERVAL_MS || String(7 * 24 * HOURS), 10),
    retryDelayMs: parseInt(process.env[`${prefix}RETRY_DELAY_MS`] || process.env.RETRY_DELAY_MS || String(5 * 60 * 1000), 10),
    updateLimit: parseInt(process.env[`${prefix}UPDATE_LIMIT`] || process.env.UPDATE_LIMIT || '100', 10),
    dueSourcePrefix: process.env[`${prefix}DUE_SOURCE_PREFIX`] || process.env.DUE_SOURCE_PREFIX || (chainKey === 'ROBIN' ? 'liquidity:' : ''),
    skipExistingDueTokens: envFlag(`${prefix}SKIP_EXISTING_DUE_TOKENS`, envFlag('SKIP_EXISTING_DUE_TOKENS', chainKey === 'ROBIN')),
    persistLiquidityDetails: envFlag(`${prefix}PERSIST_LIQUIDITY_DETAILS`, envFlag('PERSIST_LIQUIDITY_DETAILS', false)),
    polling: {
      enabled: envFlag(`${prefix}POLLING_ENABLED`, envFlag('POLLING_ENABLED', false)),
      intervalMs: parseInt(process.env[`${prefix}POLLING_INTERVAL_MS`] || process.env.POLLING_INTERVAL_MS || '3000', 10),
      batchBlocks: parseInt(process.env[`${prefix}POLLING_BATCH_BLOCKS`] || process.env.POLLING_BATCH_BLOCKS || '64', 10),
      maxConcurrentBlocks: parseInt(process.env[`${prefix}POLLING_MAX_CONCURRENT_BLOCKS`] || process.env.POLLING_MAX_CONCURRENT_BLOCKS || (chainKey === 'BSC' ? '8' : '4'), 10),
      confirmations: parseInt(process.env[`${prefix}POLLING_CONFIRMATIONS`] || process.env.POLLING_CONFIRMATIONS || process.env[`${prefix}DISCOVERY_CONFIRMATIONS`] || process.env.DISCOVERY_CONFIRMATIONS || '12', 10),
      initialBackfillBlocks: parseInt(process.env[`${prefix}POLLING_INITIAL_BACKFILL_BLOCKS`] || process.env.POLLING_INITIAL_BACKFILL_BLOCKS || process.env[`${prefix}SUBSCRIPTION_BACKFILL_BLOCKS`] || process.env.SUBSCRIPTION_BACKFILL_BLOCKS || '64', 10)
    },
    autoMigrate: process.env.DB_AUTO_MIGRATE !== '0',
    seedTokens: parseList(process.env[`${prefix}TOKEN_ADDRESSES`] || process.env.TOKEN_ADDRESSES),
    discovery: {
      enabled: envFlag(`${prefix}DISCOVERY_ENABLED`, envFlag('DISCOVERY_ENABLED', false)),
      protocol: discoveryProtocol,
      sourceKey: process.env[`${prefix}DISCOVERY_SOURCE_KEY`] || defaultDiscoverySourceKey(chainKey, discoveryProtocol),
      backfillEnabled: envFlag(`${prefix}DISCOVERY_BACKFILL_ENABLED`, envFlag('DISCOVERY_BACKFILL_ENABLED', true)),
      factoryAddress: process.env[`${prefix}DISCOVERY_FACTORY`]
        || process.env.DISCOVERY_FACTORY
        || process.env[`${prefix}UNISWAP_V3_FACTORY`]
        || process.env.UNISWAP_V3_FACTORY
        || process.env[`${prefix}UNISWAP_V2_FACTORY`]
        || process.env.UNISWAP_V2_FACTORY
        || defaultDiscoveryFactory(chainKey, discoveryProtocol),
      fromBlock: process.env[`${prefix}DISCOVERY_FROM_BLOCK`] || process.env.DISCOVERY_FROM_BLOCK || 0,
      confirmations: parseInt(process.env[`${prefix}DISCOVERY_CONFIRMATIONS`] || process.env.DISCOVERY_CONFIRMATIONS || '12', 10),
      batchBlocks: parseInt(process.env[`${prefix}DISCOVERY_BATCH_BLOCKS`] || process.env.DISCOVERY_BATCH_BLOCKS || '2000', 10),
      subscriptionBackfillBlocks: parseInt(process.env[`${prefix}SUBSCRIPTION_BACKFILL_BLOCKS`] || process.env.SUBSCRIPTION_BACKFILL_BLOCKS || '64', 10),
      subscriptionReconnectDelayMs: parseInt(process.env[`${prefix}SUBSCRIPTION_RECONNECT_DELAY_MS`] || process.env.SUBSCRIPTION_RECONNECT_DELAY_MS || '5000', 10),
      ignoreTokens: parseLowerList(process.env[`${prefix}DISCOVERY_IGNORE_TOKENS`] || process.env.DISCOVERY_IGNORE_TOKENS || process.env[`${prefix}QUOTE_TOKENS`] || process.env.QUOTE_TOKENS)
    },
    discoveries: createDiscoveryConfigs(chainKey, prefix),
    ave: {
      baseUrl: process.env.AVE_BASE_URL,
      apiKey: process.env.AVE_API_KEY,
      timeoutMs: parseInt(process.env.AVE_TIMEOUT_MS || '15000', 10),
      retries: parseInt(process.env.AVE_RETRIES || '2', 10),
      authHeader: process.env.AVE_AUTH_HEADER || 'authorization'
    },
    audit: {
      enabled: envFlag(`${prefix}LORAI_AUDIT_ENABLED`, envFlag('LORAI_AUDIT_ENABLED', false)),
      minLiquidityUsd: parseFloat(process.env[`${prefix}LORAI_AUDIT_MIN_LIQUIDITY_USD`] || process.env.LORAI_AUDIT_MIN_LIQUIDITY_USD || '5000'),
      baseUrl: process.env.LORAI_AUDIT_BASE_URL,
      apiKey: process.env.LORAI_AUDIT_API_KEY,
      rpcUrl,
      validationMode: process.env.LORAI_AUDIT_VALIDATION_MODE || 'onchain_trace',
      codexMode: process.env.LORAI_AUDIT_CODEX_MODE || 'real',
      priority: parseInt(process.env[`${prefix}LORAI_AUDIT_PRIORITY`] || process.env.LORAI_AUDIT_PRIORITY || '100', 10),
      maxRetries: parseInt(process.env.LORAI_AUDIT_MAX_RETRIES || '2', 10),
      timeoutMs: parseInt(process.env.LORAI_AUDIT_TIMEOUT_MS || '15000', 10)
    },
    bytecodeFilter: {
      enabled: envFlag(`${prefix}TOKEN_BYTECODE_FILTER_ENABLED`, envFlag('TOKEN_BYTECODE_FILTER_ENABLED', chainKey === 'ROBIN')),
      rules: parseBytecodeFilterRules(process.env[`${prefix}TOKEN_BYTECODE_FILTER_RULES`] || process.env.TOKEN_BYTECODE_FILTER_RULES || '').length > 0
        ? parseBytecodeFilterRules(process.env[`${prefix}TOKEN_BYTECODE_FILTER_RULES`] || process.env.TOKEN_BYTECODE_FILTER_RULES || '')
        : defaultBytecodeFilterRules(chainKey),
      rpcTimeoutMs: parseInt(process.env[`${prefix}TOKEN_BYTECODE_FILTER_RPC_TIMEOUT_MS`] || process.env.TOKEN_BYTECODE_FILTER_RPC_TIMEOUT_MS || '10000', 10)
    },
    calibration: {
      enabled: envFlag(
        `${prefix}LIQUIDITY_CALIBRATION_ENABLED`,
        envFlag('LIQUIDITY_CALIBRATION_ENABLED', chainKey === 'BSC' || chainKey === 'ETH' || chainKey === 'BASE' || chainKey === 'ROBIN')
      ),
      maxPairs: parseInt(process.env[`${prefix}LIQUIDITY_CALIBRATION_MAX_PAIRS`] || process.env.LIQUIDITY_CALIBRATION_MAX_PAIRS || '10', 10),
      factoryLookupEnabled: envFlag(
        `${prefix}LIQUIDITY_FACTORY_LOOKUP_ENABLED`,
        envFlag('LIQUIDITY_FACTORY_LOOKUP_ENABLED', chainKey === 'BSC' || chainKey === 'ETH' || chainKey === 'BASE' || chainKey === 'ROBIN')
      ),
      v3Fees: parseNumberList(process.env[`${prefix}LIQUIDITY_FACTORY_V3_FEES`] || process.env.LIQUIDITY_FACTORY_V3_FEES || '').length > 0
        ? parseNumberList(process.env[`${prefix}LIQUIDITY_FACTORY_V3_FEES`] || process.env.LIQUIDITY_FACTORY_V3_FEES || '')
        : defaultFactoryV3Fees(chainKey)
    },
    proxyUpgrade: {
      enabled: envFlag(`${prefix}PROXY_UPGRADE_MONITOR_ENABLED`, envFlag('PROXY_UPGRADE_MONITOR_ENABLED', false)),
      subscribeEnabled: envFlag(`${prefix}PROXY_UPGRADE_SUBSCRIBE_ENABLED`, envFlag('PROXY_UPGRADE_SUBSCRIBE_ENABLED', false)),
      triggerAudit: envFlag(`${prefix}PROXY_UPGRADE_TRIGGER_AUDIT`, envFlag('PROXY_UPGRADE_TRIGGER_AUDIT', true)),
      backfillEnabled: envFlag(`${prefix}PROXY_UPGRADE_BACKFILL_ENABLED`, envFlag('PROXY_UPGRADE_BACKFILL_ENABLED', true)),
      minLiquidityUsd: parseFloat(process.env[`${prefix}PROXY_UPGRADE_MIN_LIQUIDITY_USD`] || process.env.PROXY_UPGRADE_MIN_LIQUIDITY_USD || process.env[`${prefix}LORAI_AUDIT_MIN_LIQUIDITY_USD`] || process.env.LORAI_AUDIT_MIN_LIQUIDITY_USD || '5000'),
      sourceKey: process.env[`${prefix}PROXY_UPGRADE_SOURCE_KEY`] || `proxy-upgrade:${chainKey.toLowerCase()}-erc1967-upgraded`,
      fromBlock: process.env[`${prefix}PROXY_UPGRADE_FROM_BLOCK`] || process.env.PROXY_UPGRADE_FROM_BLOCK || 'latest',
      confirmations: parseInt(process.env[`${prefix}PROXY_UPGRADE_CONFIRMATIONS`] || process.env.PROXY_UPGRADE_CONFIRMATIONS || process.env[`${prefix}DISCOVERY_CONFIRMATIONS`] || process.env.DISCOVERY_CONFIRMATIONS || '12', 10),
      batchBlocks: parseInt(process.env[`${prefix}PROXY_UPGRADE_BATCH_BLOCKS`] || process.env.PROXY_UPGRADE_BATCH_BLOCKS || '100', 10),
      ignoreTokens: parseLowerList(process.env[`${prefix}PROXY_UPGRADE_IGNORE_TOKENS`] || process.env.PROXY_UPGRADE_IGNORE_TOKENS || process.env[`${prefix}DISCOVERY_IGNORE_TOKENS`] || process.env.DISCOVERY_IGNORE_TOKENS || process.env[`${prefix}QUOTE_TOKENS`] || process.env.QUOTE_TOKENS)
    },
    methodCallMonitor: {
      enabled: envFlag(`${prefix}METHOD_CALL_MONITOR_ENABLED`, envFlag('METHOD_CALL_MONITOR_ENABLED', false)),
      subscribeEnabled: envFlag(`${prefix}METHOD_CALL_SUBSCRIBE_ENABLED`, envFlag('METHOD_CALL_SUBSCRIBE_ENABLED', true)),
      triggerAudit: envFlag(`${prefix}METHOD_CALL_TRIGGER_AUDIT`, envFlag('METHOD_CALL_TRIGGER_AUDIT', false)),
      minValueUsd: parseFloat(process.env[`${prefix}METHOD_CALL_MIN_VALUE_USD`] || process.env.METHOD_CALL_MIN_VALUE_USD || process.env[`${prefix}LORAI_AUDIT_MIN_LIQUIDITY_USD`] || process.env.LORAI_AUDIT_MIN_LIQUIDITY_USD || '40000'),
      methods: parseMethodList(process.env[`${prefix}METHOD_CALL_SELECTORS`] || process.env.METHOD_CALL_SELECTORS || ''),
      signatures: [
        ...(
          envFlag(`${prefix}METHOD_CALL_USE_DEFAULT_SIGNATURES`, envFlag('METHOD_CALL_USE_DEFAULT_SIGNATURES', true))
            ? defaultSensitiveMethodSignatures()
            : []
        ),
        ...parseMethodSignatureList(process.env[`${prefix}METHOD_CALL_SIGNATURES`] || process.env.METHOD_CALL_SIGNATURES || '')
      ],
      denylist: parseLowerList(process.env[`${prefix}METHOD_CALL_DENYLIST`] || process.env.METHOD_CALL_DENYLIST || '').length > 0
        ? parseLowerList(process.env[`${prefix}METHOD_CALL_DENYLIST`] || process.env.METHOD_CALL_DENYLIST || '')
        : defaultMethodCallDenylist(chainKey),
      skipObservedPools: envFlag(`${prefix}METHOD_CALL_SKIP_OBSERVED_POOLS`, envFlag('METHOD_CALL_SKIP_OBSERVED_POOLS', chainKey === 'BSC')),
      skipErc20LikeTargets: envFlag(`${prefix}METHOD_CALL_SKIP_ERC20_LIKE_TARGETS`, envFlag('METHOD_CALL_SKIP_ERC20_LIKE_TARGETS', true)),
      quoteTokens: parseQuoteTokenList(process.env[`${prefix}METHOD_CALL_QUOTE_TOKENS`] || process.env.METHOD_CALL_QUOTE_TOKENS || '').length > 0
        ? parseQuoteTokenList(process.env[`${prefix}METHOD_CALL_QUOTE_TOKENS`] || process.env.METHOD_CALL_QUOTE_TOKENS || '')
        : defaultMethodCallQuoteTokens(chainKey),
      nativeAsset: defaultNativeAssetConfig(chainKey, prefix),
      cooldownMs: parseInt(process.env[`${prefix}METHOD_CALL_COOLDOWN_MS`] || process.env.METHOD_CALL_COOLDOWN_MS || String(24 * HOURS), 10),
      maxTransactionsPerBlock: parseInt(process.env[`${prefix}METHOD_CALL_MAX_TX_PER_BLOCK`] || process.env.METHOD_CALL_MAX_TX_PER_BLOCK || '2000', 10),
      maxConcurrentBlocks: parseInt(process.env[`${prefix}METHOD_CALL_MAX_CONCURRENT_BLOCKS`] || process.env.METHOD_CALL_MAX_CONCURRENT_BLOCKS || (chainKey === 'BSC' ? '8' : '4'), 10),
      maxConcurrentTransactions: parseInt(process.env[`${prefix}METHOD_CALL_MAX_CONCURRENT_TX`] || process.env.METHOD_CALL_MAX_CONCURRENT_TX || (chainKey === 'BSC' ? '8' : '4'), 10),
      maxQueuedBlocks: parseInt(process.env[`${prefix}METHOD_CALL_MAX_QUEUED_BLOCKS`] || process.env.METHOD_CALL_MAX_QUEUED_BLOCKS || '1000', 10),
      rpcTimeoutMs: parseInt(process.env[`${prefix}METHOD_CALL_RPC_TIMEOUT_MS`] || process.env.METHOD_CALL_RPC_TIMEOUT_MS || '10000', 10),
      blockFetchRetries: parseInt(process.env[`${prefix}METHOD_CALL_BLOCK_FETCH_RETRIES`] || process.env.METHOD_CALL_BLOCK_FETCH_RETRIES || (chainKey === 'ARB' ? '2' : '1'), 10),
      priority: parseInt(process.env[`${prefix}METHOD_CALL_AUDIT_PRIORITY`] || process.env.METHOD_CALL_AUDIT_PRIORITY || process.env[`${prefix}LORAI_AUDIT_PRIORITY`] || process.env.LORAI_AUDIT_PRIORITY || '100', 10)
    },
    contractValueMonitor: {
      enabled: envFlag(`${prefix}CONTRACT_VALUE_MONITOR_ENABLED`, envFlag('CONTRACT_VALUE_MONITOR_ENABLED', false)),
      subscribeEnabled: envFlag(`${prefix}CONTRACT_VALUE_MONITOR_SUBSCRIBE_ENABLED`, envFlag('CONTRACT_VALUE_MONITOR_SUBSCRIBE_ENABLED', true)),
      triggerScan: envFlag(`${prefix}CONTRACT_VALUE_MONITOR_TRIGGER_SCAN`, envFlag('CONTRACT_VALUE_MONITOR_TRIGGER_SCAN', false)),
      minTotalUsd: parseFloat(process.env[`${prefix}CONTRACT_VALUE_MONITOR_MIN_TOTAL_USD`] || process.env.CONTRACT_VALUE_MONITOR_MIN_TOTAL_USD || '20000'),
      nativeAsset: defaultContractValueNativeAssetConfig(chainKey, prefix),
      coreAssets: parseContractValueAssetList(process.env[`${prefix}CONTRACT_VALUE_MONITOR_ASSETS`] || process.env.CONTRACT_VALUE_MONITOR_ASSETS || '').length > 0
        ? parseContractValueAssetList(process.env[`${prefix}CONTRACT_VALUE_MONITOR_ASSETS`] || process.env.CONTRACT_VALUE_MONITOR_ASSETS || '')
        : defaultContractValueMonitorAssets(chainKey),
      denylist: parseLowerList(process.env[`${prefix}CONTRACT_VALUE_MONITOR_DENYLIST`] || process.env.CONTRACT_VALUE_MONITOR_DENYLIST || '').length > 0
        ? parseLowerList(process.env[`${prefix}CONTRACT_VALUE_MONITOR_DENYLIST`] || process.env.CONTRACT_VALUE_MONITOR_DENYLIST || '')
        : defaultContractValueDenylist(chainKey),
      skipObservedPools: envFlag(`${prefix}CONTRACT_VALUE_MONITOR_SKIP_OBSERVED_POOLS`, envFlag('CONTRACT_VALUE_MONITOR_SKIP_OBSERVED_POOLS', chainKey === 'BSC')),
      skipErc20LikeTargets: envFlag(`${prefix}CONTRACT_VALUE_MONITOR_SKIP_ERC20_LIKE_TARGETS`, envFlag('CONTRACT_VALUE_MONITOR_SKIP_ERC20_LIKE_TARGETS', chainKey === 'BSC')),
      comboMinAssetCount: parseInt(process.env[`${prefix}CONTRACT_VALUE_MONITOR_COMBO_MIN_ASSET_COUNT`] || process.env.CONTRACT_VALUE_MONITOR_COMBO_MIN_ASSET_COUNT || (chainKey === 'BSC' ? '3' : '0'), 10),
      comboMinTotalUsd: parseFloat(process.env[`${prefix}CONTRACT_VALUE_MONITOR_COMBO_MIN_TOTAL_USD`] || process.env.CONTRACT_VALUE_MONITOR_COMBO_MIN_TOTAL_USD || (chainKey === 'BSC' ? '100000' : '0')),
      singleMinValueUsd: parseFloat(process.env[`${prefix}CONTRACT_VALUE_MONITOR_SINGLE_MIN_VALUE_USD`] || process.env.CONTRACT_VALUE_MONITOR_SINGLE_MIN_VALUE_USD || (chainKey === 'BSC' ? '100000' : '0')),
      cooldownMs: parseInt(process.env[`${prefix}CONTRACT_VALUE_MONITOR_COOLDOWN_MS`] || process.env.CONTRACT_VALUE_MONITOR_COOLDOWN_MS || '86400000', 10),
      maxObservedPerBlock: parseInt(process.env[`${prefix}CONTRACT_VALUE_MONITOR_MAX_OBSERVED_PER_BLOCK`] || process.env.CONTRACT_VALUE_MONITOR_MAX_OBSERVED_PER_BLOCK || (chainKey === 'BSC' ? '2' : '0'), 10),
      maxTransactionsPerBlock: parseInt(process.env[`${prefix}CONTRACT_VALUE_MONITOR_MAX_TX_PER_BLOCK`] || process.env.CONTRACT_VALUE_MONITOR_MAX_TX_PER_BLOCK || '5000', 10),
      maxContractsPerBlock: parseInt(process.env[`${prefix}CONTRACT_VALUE_MONITOR_MAX_CONTRACTS_PER_BLOCK`] || process.env.CONTRACT_VALUE_MONITOR_MAX_CONTRACTS_PER_BLOCK || '200', 10),
      maxConcurrentContracts: parseInt(process.env[`${prefix}CONTRACT_VALUE_MONITOR_MAX_CONCURRENT_CONTRACTS`] || process.env.CONTRACT_VALUE_MONITOR_MAX_CONCURRENT_CONTRACTS || '10', 10),
      maxConcurrentBlocks: parseInt(process.env[`${prefix}CONTRACT_VALUE_MONITOR_MAX_CONCURRENT_BLOCKS`] || process.env.CONTRACT_VALUE_MONITOR_MAX_CONCURRENT_BLOCKS || (chainKey === 'BSC' ? '4' : '2'), 10),
      maxQueuedBlocks: parseInt(process.env[`${prefix}CONTRACT_VALUE_MONITOR_MAX_QUEUED_BLOCKS`] || process.env.CONTRACT_VALUE_MONITOR_MAX_QUEUED_BLOCKS || '1000', 10),
      logEveryBlock: envFlag(`${prefix}CONTRACT_VALUE_MONITOR_LOG_EVERY_BLOCK`, envFlag('CONTRACT_VALUE_MONITOR_LOG_EVERY_BLOCK', false)),
      priority: parseInt(process.env[`${prefix}CONTRACT_VALUE_MONITOR_AUDIT_PRIORITY`] || process.env.CONTRACT_VALUE_MONITOR_AUDIT_PRIORITY || process.env[`${prefix}LORAI_AUDIT_PRIORITY`] || process.env.LORAI_AUDIT_PRIORITY || '100', 10)
    },
    flapVaultFactory: {
      enabled: envFlag(`${prefix}FLAP_VAULT_FACTORY_MONITOR_ENABLED`, envFlag('FLAP_VAULT_FACTORY_MONITOR_ENABLED', chainKey === 'BSC')),
      subscribeEnabled: envFlag(`${prefix}FLAP_VAULT_FACTORY_SUBSCRIBE_ENABLED`, envFlag('FLAP_VAULT_FACTORY_SUBSCRIBE_ENABLED', true)),
      triggerAudit: envFlag(`${prefix}FLAP_VAULT_FACTORY_TRIGGER_AUDIT`, envFlag('FLAP_VAULT_FACTORY_TRIGGER_AUDIT', true)),
      backfillEnabled: envFlag(`${prefix}FLAP_VAULT_FACTORY_BACKFILL_ENABLED`, envFlag('FLAP_VAULT_FACTORY_BACKFILL_ENABLED', false)),
      portalAddress: String(process.env[`${prefix}FLAP_VAULT_PORTAL_ADDRESS`] || process.env.FLAP_VAULT_PORTAL_ADDRESS || (chainKey === 'BSC' ? '0x90497450f2a706f1951b5bdda52B4E5d16f34C06' : '')).toLowerCase(),
      sourceKey: process.env[`${prefix}FLAP_VAULT_FACTORY_SOURCE_KEY`] || `flap:${chainKey.toLowerCase()}-vault-factory`,
      fromBlock: process.env[`${prefix}FLAP_VAULT_FACTORY_FROM_BLOCK`] || process.env.FLAP_VAULT_FACTORY_FROM_BLOCK || 'latest',
      confirmations: parseInt(process.env[`${prefix}FLAP_VAULT_FACTORY_CONFIRMATIONS`] || process.env.FLAP_VAULT_FACTORY_CONFIRMATIONS || process.env[`${prefix}DISCOVERY_CONFIRMATIONS`] || process.env.DISCOVERY_CONFIRMATIONS || '12', 10),
      batchBlocks: parseInt(process.env[`${prefix}FLAP_VAULT_FACTORY_BATCH_BLOCKS`] || process.env.FLAP_VAULT_FACTORY_BATCH_BLOCKS || '100', 10),
      priority: parseInt(process.env[`${prefix}FLAP_VAULT_FACTORY_AUDIT_PRIORITY`] || process.env.FLAP_VAULT_FACTORY_AUDIT_PRIORITY || process.env[`${prefix}LORAI_AUDIT_PRIORITY`] || process.env.LORAI_AUDIT_PRIORITY || '100', 10)
    },
    targets: [
      {
        name: process.env[`${prefix}AVE_TARGET_NAME`] || 'ave-liquidity',
        sourceType: 'ave_liquidity_v1',
        platform: process.env.AVE_PLATFORM || 'web',
        lang: process.env.AVE_LANG || 'en',
        ammAllowlist: parseLowerList(process.env[`${prefix}AMM_ALLOWLIST`] || process.env.AMM_ALLOWLIST),
        batchSize: parseInt(process.env[`${prefix}BATCH_SIZE`] || process.env.AVE_BATCH_SIZE || process.env.UPDATE_LIMIT || '100', 10),
        drainUntilEmpty: envFlag(`${prefix}DRAIN_DUE_TOKENS`, envFlag('DRAIN_DUE_TOKENS', false)),
        retryDelayMs: parseInt(process.env[`${prefix}RETRY_DELAY_MS`] || process.env.RETRY_DELAY_MS || String(5 * 60 * 1000), 10)
      }
    ]
  };
}

module.exports = {
  BSC: {
    displayName: 'BNB Smart Chain',
    chainId: 56,
    provider: process.env.BSC_PROVIDER || 'ws',
    rpc: {
      http: process.env.BSC_RPC || 'http://100.101.251.87:20200',
      ws: process.env.BSC_WS_RPC || 'ws://100.101.251.87:20201'
    },
    db: {
      host: process.env.BSC_DB_HOST || process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.BSC_DB_PORT || process.env.DB_PORT || '3306', 10),
      user: process.env.BSC_DB_USER || process.env.DB_USER || 'root',
      password: process.env.BSC_DB_PASSWORD || process.env.DB_PASSWORD || '',
      database: process.env.BSC_DB_NAME || process.env.DB_NAME || 'ave_scanner'
    },
    scan: process.env.BSC_SCAN_SOURCE === 'private_contract_v1' || process.env.SCAN_SOURCE === 'private_contract_v1' ? {
      sourceType: 'private_contract_v1',
      scanIntervalMs: parseInt(process.env.BSC_SCAN_INTERVAL_MS || process.env.GET_TOKEN_INTERVAL || String(HOURS), 10),
      refreshIntervalMs: parseInt(process.env.BSC_REFRESH_INTERVAL_MS || process.env.REFRESH_INTERVAL_MS || String(12 * HOURS), 10),
      topPoolIntervalMs: parseInt(process.env.BSC_TOP_POOL_INTERVAL_MS || process.env.TOP_POOL_INTERVAL_MS || String(HOURS), 10),
      staleAfterMs: parseInt(process.env.BSC_STALE_AFTER_MS || process.env.STALE_AFTER_MS || String(72 * HOURS), 10),
      updateLimit: parseInt(process.env.BSC_UPDATE_LIMIT || process.env.UPDATE_LIMIT || '100000', 10),
      targets: [
        {
          name: 'pancakeswap-v2',
          dexType: 'uniswap-v2-compatible',
          privateContractAddress: process.env.BSC_PRIVATE_CONTRACT || process.env.PRIVATE_CONTRACT || '',
          factoryTable: process.env.BSC_FACTORY_TABLE || 'Factory',
          tokenTable: process.env.BSC_TOKEN_TABLE || 'Token',
          factoryId: parseInt(process.env.BSC_FACTORY_ID || '1', 10),
          quoteAssets: [
            { field: 'WBNB', amountIndex: 0 },
            { field: 'USDT', amountIndex: 1 },
            { field: 'BUSD', amountIndex: 2 }
          ],
          topPoolFields: ['USDT', 'WBNB'],
          routers: [
            {
              name: 'pancakeswap-v2',
              type: 'uniswap-v2',
              address: process.env.BSC_ROUTER_V2 || '0x10ED43C718714eb63d5aA57B78B54704E256024E'
            }
          ]
        }
      ]
    } : aveScanConfig('BSC')
  },
  ETH: {
    displayName: 'Ethereum',
    chainId: 1,
    provider: process.env.ETH_PROVIDER || 'http',
    rpc: {
      http: process.env.ETH_RPC || 'http://100.101.251.87:20000',
      ws: process.env.ETH_WS_RPC || process.env.ETH_RPC || 'ws://100.101.251.87:20001'
    },
    db: {
      host: process.env.ETH_DB_HOST || process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.ETH_DB_PORT || process.env.DB_PORT || '3306', 10),
      user: process.env.ETH_DB_USER || process.env.DB_USER || 'root',
      password: process.env.ETH_DB_PASSWORD || process.env.DB_PASSWORD || '',
      database: process.env.ETH_DB_NAME || process.env.DB_NAME || 'ave_scanner'
    },
    scan: process.env.ETH_SCAN_SOURCE === 'private_contract_v1' || process.env.SCAN_SOURCE === 'private_contract_v1' ? {
      sourceType: 'private_contract_v1',
      scanIntervalMs: parseInt(process.env.ETH_SCAN_INTERVAL_MS || process.env.GET_TOKEN_INTERVAL || String(HOURS), 10),
      refreshIntervalMs: parseInt(process.env.ETH_REFRESH_INTERVAL_MS || process.env.REFRESH_INTERVAL_MS || String(12 * HOURS), 10),
      topPoolIntervalMs: parseInt(process.env.ETH_TOP_POOL_INTERVAL_MS || process.env.TOP_POOL_INTERVAL_MS || String(HOURS), 10),
      staleAfterMs: parseInt(process.env.ETH_STALE_AFTER_MS || process.env.STALE_AFTER_MS || String(72 * HOURS), 10),
      updateLimit: parseInt(process.env.ETH_UPDATE_LIMIT || process.env.UPDATE_LIMIT || '50000', 10),
      targets: [
        {
          name: 'uniswap-v2',
          dexType: 'uniswap-v2-compatible',
          privateContractAddress: process.env.ETH_PRIVATE_CONTRACT || '',
          factoryTable: process.env.ETH_FACTORY_TABLE || 'Factory',
          tokenTable: process.env.ETH_TOKEN_TABLE || 'Token',
          factoryId: parseInt(process.env.ETH_FACTORY_ID || '1', 10),
          quoteAssets: [
            { field: 'WETH', amountIndex: 0 },
            { field: 'USDT', amountIndex: 1 },
            { field: 'USDC', amountIndex: 2 }
          ],
          topPoolFields: ['USDT', 'USDC', 'WETH'],
          routers: [
            {
              name: 'uniswap-v2',
              type: 'uniswap-v2',
              address: process.env.ETH_ROUTER_V2 || '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
            }
          ]
        }
      ]
    } : aveScanConfig('ETH')
  },
  BASE: {
    displayName: 'Base',
    chainId: 8453,
    provider: process.env.BASE_PROVIDER || 'ws',
    rpc: {
      http: process.env.BASE_RPC || '',
      ws: process.env.BASE_WS_RPC || process.env.BASE_RPC || ''
    },
    db: {
      host: process.env.BASE_DB_HOST || process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.BASE_DB_PORT || process.env.DB_PORT || '3306', 10),
      user: process.env.BASE_DB_USER || process.env.DB_USER || 'root',
      password: process.env.BASE_DB_PASSWORD || process.env.DB_PASSWORD || '',
      database: process.env.BASE_DB_NAME || process.env.DB_NAME || 'ave_scanner'
    },
    scan: aveScanConfig('BASE')
  },
  ARB: {
    displayName: 'Arbitrum One',
    chainId: 42161,
    provider: process.env.ARB_PROVIDER || 'http',
    rpc: {
      http: process.env.ARB_RPC || 'http://100.101.251.87:20500',
      ws: process.env.ARB_WS_RPC || 'ws://100.101.251.87:20501'
    },
    db: {
      host: process.env.ARB_DB_HOST || process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.ARB_DB_PORT || process.env.DB_PORT || '3306', 10),
      user: process.env.ARB_DB_USER || process.env.DB_USER || 'root',
      password: process.env.ARB_DB_PASSWORD || process.env.DB_PASSWORD || '',
      database: process.env.ARB_DB_NAME || process.env.DB_NAME || 'ave_scanner'
    },
    scan: process.env.ARB_SCAN_SOURCE === 'private_contract_v1' || process.env.SCAN_SOURCE === 'private_contract_v1' ? {
      sourceType: 'private_contract_v1',
      scanIntervalMs: parseInt(process.env.ARB_SCAN_INTERVAL_MS || process.env.GET_TOKEN_INTERVAL || String(HOURS), 10),
      refreshIntervalMs: parseInt(process.env.ARB_REFRESH_INTERVAL_MS || process.env.REFRESH_INTERVAL_MS || String(12 * HOURS), 10),
      topPoolIntervalMs: parseInt(process.env.ARB_TOP_POOL_INTERVAL_MS || process.env.TOP_POOL_INTERVAL_MS || String(HOURS), 10),
      staleAfterMs: parseInt(process.env.ARB_STALE_AFTER_MS || process.env.STALE_AFTER_MS || String(72 * HOURS), 10),
      updateLimit: parseInt(process.env.ARB_UPDATE_LIMIT || process.env.UPDATE_LIMIT || '50000', 10),
      targets: [
        {
          name: 'uniswap-v2-family',
          dexType: 'uniswap-v2-compatible',
          privateContractAddress: process.env.ARB_PRIVATE_CONTRACT || '',
          factoryTable: process.env.ARB_FACTORY_TABLE || 'Factory',
          tokenTable: process.env.ARB_TOKEN_TABLE || 'Token',
          factoryId: parseInt(process.env.ARB_FACTORY_ID || '1', 10),
          quoteAssets: [
            { field: 'WETH', amountIndex: 0 },
            { field: 'USDT', amountIndex: 1 },
            { field: 'USDC', amountIndex: 2 }
          ],
          topPoolFields: ['USDT', 'USDC', 'WETH'],
          routers: [
            {
              name: 'sushiswap',
              type: 'uniswap-v2',
              address: process.env.ARB_ROUTER_V2 || '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506'
            }
          ]
        }
      ]
    } : aveScanConfig('ARB')
  },
  ROBIN: {
    displayName: 'Robinhood Chain',
    chainId: 4663,
    provider: process.env.ROBIN_PROVIDER || 'http',
    rpc: {
      http: process.env.ROBIN_RPC || process.env.HTTP_ROBIN || 'http://100.77.238.5:38547',
      ws: process.env.ROBIN_WS_RPC || process.env.WS_ROBIN || process.env.ROBIN_RPC || process.env.HTTP_ROBIN || 'ws://100.77.238.5:38549'
    },
    db: {
      host: process.env.ROBIN_DB_HOST || process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.ROBIN_DB_PORT || process.env.DB_PORT || '3306', 10),
      user: process.env.ROBIN_DB_USER || process.env.DB_USER || 'root',
      password: process.env.ROBIN_DB_PASSWORD || process.env.DB_PASSWORD || '',
      database: process.env.ROBIN_DB_NAME || process.env.DB_NAME || 'ave_scanner'
    },
    scan: aveScanConfig('ROBIN')
  }
};
