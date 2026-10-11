const path = require('path');

const factoryAbi = require(path.resolve(__dirname, '../../getTokenAbi.json'));
const tokenAbi = require(path.resolve(__dirname, '../../tokenabi.json'));

class PrivateContractTokenSource {
  constructor(web3, repository, chainConfig) {
    this.web3 = web3;
    this.repository = repository;
    this.chainConfig = chainConfig;
  }

  async scanTarget(target, options = {}) {
    const dryRun = Boolean(options.dryRun);
    if (!target.privateContractAddress) {
      console.warn(`[${this.chainConfig.key}] target=${target.name} 未配置 privateContractAddress，跳过`);
      return;
    }

    const factoryRow = await this.repository.getFactoryRow(target.factoryTable, target.factoryId);
    if (!factoryRow) {
      throw new Error(`[${this.chainConfig.key}] 在表 ${target.factoryTable} 中找不到 Factory.Id=${target.factoryId}`);
    }

    const factoryAddress = factoryRow.Address;
    const currentPickIndex = Number(factoryRow.PickIndex || 0);
    const factoryContract = new this.web3.eth.Contract(factoryAbi, factoryAddress);
    const privateContract = new this.web3.eth.Contract(factoryAbi, target.privateContractAddress);
    const allPairsLength = Number(await factoryContract.methods.allPairsLength().call());

    console.log(`[${this.chainConfig.key}] target=${target.name} factory=${factoryAddress} pickIndex=${currentPickIndex} allPairsLength=${allPairsLength}`);

    for (let index = currentPickIndex + 1; index < allPairsLength; index++) {
      try {
        const info = await privateContract.methods.getToken(index).call();
        const payload = await this.buildTokenPayload(info, target.quoteAssets);
        if (dryRun) {
          console.log(`[${this.chainConfig.key}] [dry-run] target=${target.name} 发现新增 token=${info.token} id=${info.Id} metrics=${JSON.stringify(payload.metrics)}`);
        } else {
          await this.repository.upsertToken(target.tokenTable, payload);
          await this.repository.updateFactoryPickIndex(target.factoryTable, target.factoryId, info.Id);
          console.log(`[${this.chainConfig.key}] target=${target.name} 新增 token=${info.token} id=${info.Id}`);
        }
      } catch (error) {
        console.error(`[${this.chainConfig.key}] target=${target.name} index=${index} 扫描失败: ${error.message}`);
      }
    }
  }

  async refreshTarget(target, tokenIds) {
    if (!target.privateContractAddress || tokenIds.length === 0) {
      return;
    }

    const privateContract = new this.web3.eth.Contract(factoryAbi, target.privateContractAddress);

    for (const tokenId of tokenIds) {
      try {
        const info = await privateContract.methods.getToken(tokenId).call();
        const payload = await this.buildTokenPayload(info, target.quoteAssets);
        await this.repository.updateTokenMetrics(target.tokenTable, info.Id, payload);
        console.log(`[${this.chainConfig.key}] target=${target.name} 刷新 tokenId=${tokenId}`);
      } catch (error) {
        console.error(`[${this.chainConfig.key}] target=${target.name} tokenId=${tokenId} 刷新失败: ${error.message}`);
      }
    }
  }

  async buildTokenPayload(info, quoteAssets) {
    const tokenContract = new this.web3.eth.Contract(tokenAbi, info.token);
    let amount = '0';
    let totalSupply = '0';

    try {
      amount = await tokenContract.methods.balanceOf(info.token).call();
      totalSupply = await tokenContract.methods.totalSupply().call();
    } catch (error) {
      console.warn(`[${this.chainConfig.key}] token=${info.token} 读取余额失败: ${error.message}`);
    }

    const balance = this.computeBalanceRatio(amount, totalSupply);
    const metrics = {};

    for (const asset of quoteAssets) {
      metrics[asset.field] = this.web3.utils.fromWei(String(info.amount[asset.amountIndex] || '0'), 'ether');
    }

    return {
      id: info.Id,
      state: 0,
      token: info.token,
      finish: Date.now(),
      balance,
      metrics
    };
  }

  computeBalanceRatio(amount, totalSupply) {
    const aNumber = parseFloat(String(amount));
    const bNumber = parseFloat(String(totalSupply));

    if (!bNumber || Number.isNaN(aNumber) || Number.isNaN(bNumber)) {
      return '0.00';
    }

    return ((aNumber / bNumber) * 100).toFixed(2);
  }
}

module.exports = PrivateContractTokenSource;
