const Web3 = require('web3');

function createWeb3Client(chainConfig) {
  const providerType = chainConfig.provider || 'http';
  const rpc = chainConfig.rpc || {};

  if (providerType === 'ws') {
    const wsUrl = rpc.ws;
    if (!wsUrl) {
      throw new Error(`${chainConfig.key} 缺少 WS RPC 配置`);
    }

    Web3.providers.WebsocketProvider.prototype.sendAsync = Web3.providers.WebsocketProvider.prototype.send;
    return new Web3(new Web3.providers.WebsocketProvider(wsUrl, {
      reconnect: {
        auto: true,
        delay: 3000,
        maxAttempts: 100000
      }
    }));
  }

  const httpUrl = rpc.http;
  if (!httpUrl) {
    throw new Error(`${chainConfig.key} 缺少 HTTP RPC 配置`);
  }

  Web3.providers.HttpProvider.prototype.sendAsync = Web3.providers.HttpProvider.prototype.send;
  return new Web3(new Web3.providers.HttpProvider(httpUrl, {
    timeout: 30000,
    keepAlive: true
  }));
}

module.exports = createWeb3Client;
