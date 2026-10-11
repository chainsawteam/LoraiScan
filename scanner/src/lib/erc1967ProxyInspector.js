const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const ERC20_CALLS = {
  totalSupply: '0x18160ddd',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  name: '0x06fdde03'
};

class Erc1967ProxyInspector {
  constructor(web3) {
    this.web3 = web3;
  }

  async getImplementationAddress(proxyAddress) {
    if (!this.web3) {
      throw new Error('missing_web3');
    }

    const raw = await this.web3.eth.getStorageAt(proxyAddress, IMPLEMENTATION_SLOT);
    return this.parseAddressFromSlot(raw);
  }

  async isErc20Like(address) {
    if (!this.web3) {
      return false;
    }

    const totalSupplyOk = await this.callSucceeds(address, ERC20_CALLS.totalSupply);
    const decimalsOk = await this.callSucceeds(address, ERC20_CALLS.decimals);
    if (!totalSupplyOk || !decimalsOk) {
      return false;
    }

    const symbolOk = await this.callSucceeds(address, ERC20_CALLS.symbol);
    const nameOk = await this.callSucceeds(address, ERC20_CALLS.name);
    return symbolOk || nameOk;
  }

  async callSucceeds(to, data) {
    try {
      const result = await this.web3.eth.call({ to, data });
      return typeof result === 'string' && result !== '0x';
    } catch (_error) {
      return false;
    }
  }

  parseAddressFromSlot(value) {
    const hex = String(value || '').replace(/^0x/i, '').padStart(64, '0');
    if (!hex || /^0+$/.test(hex)) {
      return '';
    }

    const address = `0x${hex.slice(-40)}`.toLowerCase();
    return this.web3?.utils?.isAddress(address) ? address : '';
  }
}

module.exports = {
  Erc1967ProxyInspector,
  IMPLEMENTATION_SLOT
};
